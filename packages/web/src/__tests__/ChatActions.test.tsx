import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { useChatActions } from "../hooks/useChatActions";
import { BrowserRouter } from "react-router-dom";
import * as client from "../api/client";

vi.mock("../api/client", () => ({
  api: {
    startConversation: vi.fn(),
    sendMessage: vi.fn(),
    stop: vi.fn(),
    revert: vi.fn(),
    deleteConversation: vi.fn(),
  },
}));

describe("useChatActions", () => {
  const defaultArgs = {
    activeId: "test-id",
    currentWorkspaceUri: "file:///test/ws",
    projectSlug: "test-ws",
    refresh: vi.fn(),
    conversations: [{ id: "test-id", summary: { stepCount: 5 } }],
  };

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <BrowserRouter>{children}</BrowserRouter>
  );

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("initializes with correct default state", () => {
    const { result } = renderHook(() => useChatActions(defaultArgs), {
      wrapper,
    });

    expect(result.current.optimisticMessages).toEqual([]);
  });

  it("clears optimistic messages when clearOptimisticMessages is called", () => {
    const { result } = renderHook(() => useChatActions(defaultArgs), {
      wrapper,
    });

    act(() => {
      result.current.setOptimisticMessages([
        {
          role: "user",
          content: "test",
          type: "CORTEX_STEP_TYPE_USER_INPUT",
          stepIndex: -1,
        },
      ]);
    });

    expect(result.current.optimisticMessages).toHaveLength(1);

    act(() => {
      result.current.clearOptimisticMessages();
    });

    expect(result.current.optimisticMessages).toHaveLength(0);
  });

  it("adds an optimistic message when sending", async () => {
    const { result } = renderHook(() => useChatActions(defaultArgs), {
      wrapper,
    });

    vi.mocked(client.api.sendMessage).mockResolvedValueOnce(undefined);

    await act(async () => {
      await result.current.handleSend("test message", null);
    });

    expect(result.current.optimisticMessages).toHaveLength(1);
    expect(result.current.optimisticMessages[0].content).toBe("test message");
    expect(result.current.optimisticMessages[0].optimisticState).toBe(
      "unconfirmed",
    );
    expect(client.api.sendMessage).toHaveBeenCalledWith(
      "test-id",
      [{ type: "text", text: "test message" }],
      expect.any(String),
      undefined,
      undefined,
      undefined,
      false,
    );
  });

  it("removes confirmed optimistic messages by id", () => {
    const { result } = renderHook(() => useChatActions(defaultArgs), {
      wrapper,
    });

    act(() => {
      result.current.setOptimisticMessages([
        {
          role: "user",
          content: "first",
          type: "CORTEX_STEP_TYPE_USER_INPUT",
          stepIndex: -1,
          optimisticId: "opt-1",
          optimisticState: "unconfirmed",
        },
        {
          role: "user",
          content: "second",
          type: "CORTEX_STEP_TYPE_USER_INPUT",
          stepIndex: -1,
          optimisticId: "opt-2",
          optimisticState: "unconfirmed",
        },
      ]);
    });

    act(() => {
      result.current.confirmOptimisticMessages(["opt-1"]);
    });

    expect(result.current.optimisticMessages).toHaveLength(1);
    expect(result.current.optimisticMessages[0].optimisticId).toBe("opt-2");
  });

  it("remembers the verified project when creating a conversation", async () => {
    vi.mocked(client.api.startConversation).mockResolvedValueOnce({
      cascadeId: "new-id",
    });
    vi.mocked(client.api.sendMessage).mockResolvedValueOnce(undefined);
    const { result } = renderHook(
      () =>
        useChatActions({
          ...defaultArgs,
          activeId: null,
          currentWorkspaceUri: "file:///test/test-ws",
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.handleSend("hello", null);
    });

    expect(localStorage.getItem("porta:lastProjectSlug")).toBe("test-ws");
  });
});
