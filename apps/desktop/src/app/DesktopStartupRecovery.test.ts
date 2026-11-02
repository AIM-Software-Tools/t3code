import type { DesktopUpdateState } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import type * as Electron from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describe, expect, vi } from "vite-plus/test";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import { createInitialDesktopUpdateState } from "../updates/updateMachine.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import { listen, resolveStartupRecoveryOffer } from "./DesktopStartupRecovery.ts";

const updateState = (patch: Partial<DesktopUpdateState>): DesktopUpdateState => ({
  ...createInitialDesktopUpdateState(
    "0.1.3",
    { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
    "latest",
  ),
  enabled: true,
  ...patch,
});

it.effect(
  "shows startup recovery when the early main window is still waiting for its backend",
  () =>
    Effect.gen(function* () {
      const loadURL = vi.fn();
      const recoveryWindow = {
        isDestroyed: () => false,
        loadURL,
        once: vi.fn(),
        webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn() },
      } as unknown as Electron.BrowserWindow;
      const checked = yield* Deferred.make<void>();
      const main = yield* Ref.make(Option.some({} as Electron.BrowserWindow));
      const backendReady = yield* Ref.make(false);
      const quitting = yield* Ref.make(false);
      const primaryBackendStartup = yield* SubscriptionRef.make<DesktopState.PrimaryBackendStartup>(
        {
          _tag: "Failing",
          reason: "Backend could not start",
          output: "startup failed",
        },
      );
      const path = yield* Path.Path;
      yield* listen.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(DesktopState.DesktopState, {
              backendReady,
              quitting,
              primaryBackendStartup,
            }),
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              path,
              stateDir: "/state",
              appVersion: "0.1.3",
              logDir: "/logs",
            } as DesktopEnvironment.DesktopEnvironment["Service"]),
            Layer.mock(ElectronApp.ElectronApp)({ on: () => Effect.void }),
            Layer.mock(ElectronShell.ElectronShell)({}),
            Layer.mock(ElectronTheme.ElectronTheme)({ shouldUseDarkColors: Effect.succeed(false) }),
            Layer.mock(ElectronWindow.ElectronWindow)({
              main: Ref.get(main),
              create: () => Effect.succeed(recoveryWindow),
            }),
            Layer.mock(DesktopUpdates.DesktopUpdates)({
              subscribe: Effect.succeed({ latest: updateState({}), changes: Stream.empty }),
              check: () => Deferred.succeed(checked, undefined).pipe(Effect.andThen(Effect.never)),
            }),
            FileSystem.layerNoop({ readFileString: () => Effect.succeed("0.1.3") }),
          ),
        ),
      );
      yield* Deferred.await(checked);
      expect(loadURL).toHaveBeenCalledOnce();
      expect(decodeURIComponent(loadURL.mock.calls[0]?.[0] as string)).toContain("startup failed");
    }).pipe(Effect.scoped, Effect.provide(Path.layer)),
);

describe("resolveStartupRecoveryOffer", () => {
  it("offers a newer version before going back", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "available", availableVersion: "0.1.4" }),
        "0.1.2",
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });

  it("offers a retained download after a later check fails", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "error", errorContext: "check", downloadedVersion: "0.1.4" }),
        null,
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });

  it("waits for the update check before offering to go back", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "checking" }), "0.1.2")).toEqual({
      _tag: "Checking",
    });
  });

  it("offers the last version that started when no update exists", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }), "0.1.2")).toEqual({
      _tag: "Reinstall",
      version: "0.1.2",
    });
  });

  it("does not offer an update that already failed to apply here", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({
          status: "downloaded",
          downloadedVersion: "0.1.4",
          notAppliedVersion: "0.1.4",
        }),
        "0.1.2",
      ),
    ).toEqual({ _tag: "Reinstall", version: "0.1.2" });
  });

  it("falls back to the releases page when this version never started", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "disabled" }), "0.1.3")).toEqual({
      _tag: "Releases",
    });
    expect(resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }), null)).toEqual({
      _tag: "Releases",
    });
  });
});
