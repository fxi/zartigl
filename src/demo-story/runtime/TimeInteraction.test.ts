import { describe, expect, it, vi } from "vitest";
import { StoryTimeInteraction, type StoryFrameScheduler } from "./TimeInteraction";

function harness(playing = true) {
  let frame: FrameRequestCallback | null = null;
  const frames: StoryFrameScheduler = {
    request: vi.fn((callback) => { frame = callback; return 7; }),
    cancel: vi.fn(),
  };
  const callbacks = {
    isPlaying: () => playing,
    pause: vi.fn(),
    apply: vi.fn(),
    present: vi.fn(),
    finish: vi.fn(),
  };
  const interaction = new StoryTimeInteraction(callbacks, frames);
  return { interaction, callbacks, frames, flush: () => { const callback = frame; frame = null; callback?.(0); } };
}

describe("StoryTimeInteraction", () => {
  it("presents every request immediately and applies only the latest one per frame", () => {
    const { interaction, callbacks, frames, flush } = harness();
    interaction.begin();
    interaction.request(100);
    interaction.request(200);
    interaction.request(300);

    expect(callbacks.pause).toHaveBeenCalledOnce();
    expect(callbacks.present.mock.calls.map(([time]) => time)).toEqual([100, 200, 300]);
    expect(frames.request).toHaveBeenCalledOnce();
    expect(callbacks.apply).not.toHaveBeenCalled();
    flush();
    expect(callbacks.apply).toHaveBeenCalledWith(300);
    interaction.end();
    expect(callbacks.apply).toHaveBeenCalledOnce();
  });

  it("flushes the final seek before conditionally resuming", () => {
    const active = harness(true);
    active.interaction.begin();
    active.interaction.request(400);
    active.interaction.end();
    expect(active.callbacks.apply).toHaveBeenCalledWith(400);
    expect(active.callbacks.finish).toHaveBeenCalledWith(400, true);

    const paused = harness(false);
    paused.interaction.begin();
    paused.interaction.request(500);
    paused.interaction.end();
    expect(paused.callbacks.finish).toHaveBeenCalledWith(500, false);
  });

  it("cancels a deferred seek and resume during navigation or cleanup", () => {
    const { interaction, callbacks, frames, flush } = harness();
    interaction.begin();
    interaction.request(600);
    interaction.cancel();
    flush();

    expect(frames.cancel).toHaveBeenCalledWith(7);
    expect(callbacks.apply).not.toHaveBeenCalled();
    expect(callbacks.finish).not.toHaveBeenCalled();
  });
});
