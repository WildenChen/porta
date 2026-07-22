import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChatInput } from "../components/ChatInput";

describe("ChatInput", () => {
  const mockOnSend = vi.fn();
  const mockOnStop = vi.fn();
  const mockOnDraftChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(URL, "createObjectURL", {
      writable: true,
      value: vi.fn(() => "blob:mock"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      writable: true,
      value: vi.fn(),
    });
  });

  const defaultProps = {
    onSend: mockOnSend,
    onStop: mockOnStop,
    onDraftChange: mockOnDraftChange,
    isRunning: false,
    draft: "",
  };

  it("renders correctly", () => {
    render(<ChatInput {...defaultProps} />);
    expect(
      screen.getByPlaceholderText("Send a message..."),
    ).toBeInTheDocument();
  });

  it("calls onDraftChange when typing", () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText("Send a message...");
    fireEvent.change(textarea, { target: { value: "hello" } });
    expect(mockOnDraftChange).toHaveBeenCalledWith("hello");
  });

  it("blocks oversized svg attachments before sending", async () => {
    const { container } = render(<ChatInput {...defaultProps} />);
    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();

    const file = new File(
      [new Uint8Array(1024 * 1024 + 1)],
      "large.svg",
      { type: "image/svg+xml" },
    );

    fireEvent.change(fileInput as HTMLInputElement, {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByAltText("attachment")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("Send"));

    await waitFor(() => {
      expect(mockOnSend).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "GIF and SVG attachments must stay under",
      );
    });
  });

  it("does not call onSend on Enter key press", () => {
    render(<ChatInput {...defaultProps} draft="hello" />);
    const textarea = screen.getByPlaceholderText("Send a message...");
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    expect(mockOnSend).not.toHaveBeenCalled();
  });

  it("calls onSend only when send button is clicked", async () => {
    render(<ChatInput {...defaultProps} draft="hello" />);
    const button = screen.getByTitle("Send");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(mockOnSend).toHaveBeenCalledWith("hello", expect.anything(), undefined, expect.anything());
  });

  it("does not call onSend when draft is empty", async () => {
    render(<ChatInput {...defaultProps} draft="" />);
    const button = screen.getByTitle("Send");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(mockOnSend).not.toHaveBeenCalled();
  });

  it("does not call onSend multiple times when send button is double-clicked rapidly", async () => {
    let callCount = 0;
    const mockOnSendDelayed = vi.fn().mockImplementation(async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    render(<ChatInput {...defaultProps} onSend={mockOnSendDelayed} draft="hello" />);
    const button = screen.getByTitle("Send");
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mockOnSendDelayed).toHaveBeenCalledTimes(1);
    expect(callCount).toBe(1);
  });
});
