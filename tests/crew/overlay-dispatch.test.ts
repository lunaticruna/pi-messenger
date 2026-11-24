import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";
import { MessengerOverlay } from "../../overlay.ts";
import * as store from "../../crew/store.ts";
import { startPlanningRun, finishPlanningRun, clearPlanningState, consumePendingAutoWork, revokeAutoWork, autonomousState } from "../../crew/state.ts";
import { spawnWorkersForReadyTasks, spawnSingleWorker } from "../../crew/spawn.ts";
import type { MessengerState, Dirs } from "../../lib.ts";

vi.mock("@earendil-works/pi-tui", () => ({
  matchesKey: (data: string, key: string) => data === key,
  truncateToWidth: (value: string) => value,
  visibleWidth: (value: string) => value.length,
}));
vi.mock("../../crew/spawn.ts", () => ({
  spawnWorkersForReadyTasks: vi.fn(() => ({ assigned: 1, firstWorkerName: "worker" })),
  spawnSingleWorker: vi.fn(() => ({ name: "worker" })),
}));

describe("overlay dispatch authorization (real render path, mocked spawn)", () => {
  let cwd: string;
  let overlay: MessengerOverlay | undefined;
  let dirs: Dirs;
  let state: MessengerState;
  function open() {
    overlay = new MessengerOverlay(
      { requestRender: vi.fn() } as any,
      { fg: (_color: string, text: string) => text } as any,
      state, dirs, vi.fn(), {}, cwd,
    );
    return overlay;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    cwd = createTempCrewDirs().cwd;
    const base = path.join(cwd, ".pi", "messenger");
    dirs = { base, registry: path.join(base, "registry"), inbox: path.join(base, "inbox") };
    fs.mkdirSync(dirs.registry, { recursive: true });
    fs.mkdirSync(dirs.inbox, { recursive: true });
    state = {
      cwd, agentName: "lead", registered: true, isHuman: true, model: "test/model",
      unreadCounts: new Map(), chatHistory: new Map(), broadcastHistory: [],
      reservations: [], seenSenders: new Map(), session: { toolCalls: 0, tokens: 0, filesModified: [] },
      activity: { lastActivityAt: new Date().toISOString() }, sessionStartedAt: new Date().toISOString(),
    } as MessengerState;
    autonomousState.concurrency = 2;
    store.createPlan(cwd, "docs/PRD.md");
    startPlanningRun(cwd, 1);
  });

  afterEach(() => {
    overlay?.dispose();
    overlay = undefined;
    clearPlanningState(cwd);
    vi.useRealTimers();
  });

  it("autoWork:false with overlay open never spawns on completion or redraw", () => {
    const ui = open();
    ui.render(80);
    store.createTask(cwd, "Task A");
    finishPlanningRun(cwd, "completed", 1, false);
    ui.render(80);
    ui.render(80);
    expect(spawnWorkersForReadyTasks).not.toHaveBeenCalled();
  });

  it("opening after a manual plan still allows explicit task start, not automatic refill", () => {
    const task = store.createTask(cwd, "Task A");
    store.createTask(cwd, "Task B");
    finishPlanningRun(cwd, "completed", 1, false);
    const ui = open();
    ui.render(80);
    expect(spawnWorkersForReadyTasks).not.toHaveBeenCalled();
    ui.handleInput("s");
    expect(spawnSingleWorker).toHaveBeenCalledTimes(1);
    store.updateTask(cwd, task.id, { status: "in_progress" });
    ui.render(80);
    store.updateTask(cwd, task.id, { status: "done" });
    ui.render(80);
    expect(spawnWorkersForReadyTasks).not.toHaveBeenCalled();
  });

  it("autoWork:true dispatches once, refills only while authorized, and stops on revocation", () => {
    const first = store.createTask(cwd, "Task A");
    const second = store.createTask(cwd, "Task B");
    const third = store.createTask(cwd, "Task C");
    const ui = open();
    ui.render(80);
    finishPlanningRun(cwd, "completed", 1, true);
    ui.render(80);
    ui.render(80);
    expect(spawnWorkersForReadyTasks).toHaveBeenCalledTimes(1);
    expect(consumePendingAutoWork(cwd)).toBeNull();
    store.updateTask(cwd, first.id, { status: "in_progress" });
    ui.render(80);
    store.updateTask(cwd, first.id, { status: "done" });
    ui.render(80);
    expect(spawnWorkersForReadyTasks).toHaveBeenCalledTimes(2);
    store.updateTask(cwd, second.id, { status: "in_progress" });
    ui.render(80);
    revokeAutoWork(cwd);
    store.updateTask(cwd, second.id, { status: "done" });
    ui.render(80);
    expect(store.getTask(cwd, third.id)?.status).toBe("todo");
    expect(spawnWorkersForReadyTasks).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch if the agent_end path has claimed the permit first", () => {
    store.createTask(cwd, "Task A");
    finishPlanningRun(cwd, "completed", 1, true);
    expect(consumePendingAutoWork(cwd)).not.toBeNull();
    open().render(80);
    expect(spawnWorkersForReadyTasks).not.toHaveBeenCalled();
  });

  it("failed planning cannot start ready tasks", () => {
    store.createTask(cwd, "Task A");
    const ui = open();
    ui.render(80);
    finishPlanningRun(cwd, "failed", 1, true);
    ui.render(80);
    expect(spawnWorkersForReadyTasks).not.toHaveBeenCalled();
  });
});
