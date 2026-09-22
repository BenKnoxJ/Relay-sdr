import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReadyToSend, type Ready } from "@/components/inbox/ReadyToSend";
import { SendControl } from "@/components/outreach/SendControl";
import { PersonDrawer } from "@/components/people/PersonDrawer";
import { EmailLookCard } from "@/components/settings/EmailLookCard";
import { emailLookCopy, sendCopy } from "@/lib/copy/send";
import type { SendOffer } from "@/lib/outreach/send";

import { actionsMock, draft, emailCard, personView } from "./people/fixtures";

/**
 * Sending from Outlook on screen (Relay P7): the Send button draws the
 * server's offer and nothing else; the drawer and the Inbox's ready list send
 * through the server and show what happened; and the signature box only ever
 * holds what the server's sanitiser handed back.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/campaigns/c1", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

describe("SendControl", () => {
  const draw = (offer: SendOffer, onSend = vi.fn()) => {
    render(<SendControl offer={offer} busy={false} onSend={onSend} />);
    return onSend;
  };

  it("sends on press when the server offers it", () => {
    const onSend = draw({ kind: "send" });
    fireEvent.click(screen.getByRole("button", { name: sendCopy.send }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("reads 'Send from {day}' and does nothing before the due day", () => {
    const onSend = draw({ kind: "not_due", from: "2026-10-12" });
    const button = screen.getByRole("button", { name: "Send from Mon 12 Oct" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("points to Settings where Send would be when there is no mailbox", () => {
    draw({ kind: "no_mailbox" });
    expect(screen.getByRole("link", { name: sendCopy.connect }).getAttribute("href")).toBe("/settings");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("holds Send and says why at the day's cap", () => {
    draw({ kind: "cap", cap: 30 });
    expect((screen.getByRole("button", { name: sendCopy.send }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(`30 ${sendCopy.capNote}`)).toBeDefined();
    expect(screen.getByText("30 sent today; the rest can go tomorrow.")).toBeDefined();
  });

  it.each([
    [{ kind: "paused" } as const, sendCopy.paused],
    [{ kind: "by_hand" } as const, sendCopy.byHand],
  ])("says why, with no button: %o", (offer, line) => {
    draw(offer);
    expect(screen.getByText(line)).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers a check, not a send, for one that may have gone", () => {
    const onSend = draw({ kind: "unverified" });
    expect(screen.getByText(sendCopy.unverifiedNote)).toBeDefined();
    expect(screen.queryByRole("button", { name: sendCopy.send })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: sendCopy.checkIt }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("draws nothing when there is nothing to send", () => {
    const { container } = render(<SendControl offer={{ kind: "none" }} busy={false} onSend={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});

describe("the drawer's Send", () => {
  const approved = () =>
    personView({
      drafts: { email1: draft("d-email1", { state: "approved", subject: "Calls behind complaints", body: "Complaints arrive late." }) },
      emailCards: { email1: emailCard("d-email1") },
    });

  it("sends the step through the server, shows what happened, and has the page read again", async () => {
    const actions = actionsMock();
    actions.sendEmail.mockResolvedValue({ ok: true, note: sendCopy.replied, warn: false });
    const onChanged = vi.fn();
    render(<PersonDrawer person={{ ...approved(), sendOffers: { email1: { kind: "send" } } }} closeHref="/c" actions={actions} onChanged={onChanged} />);
    const item = screen.getAllByTestId("drawer-step").find((row) => row.dataset.step === "email1")!;
    if (within(item).getByTestId("drawer-step-toggle").getAttribute("aria-expanded") === "false") fireEvent.click(within(item).getByTestId("drawer-step-toggle"));
    await act(async () => {
      fireEvent.click(within(item).getByRole("button", { name: sendCopy.send }));
    });
    expect(actions.sendEmail).toHaveBeenCalledWith({ personId: expect.any(String), step: "email1" });
    // Beside the step's Send, where the rep is, and read out from the drawer's status line.
    expect(within(item).getByTestId("drawer-send-note").textContent).toBe(sendCopy.replied);
    expect(screen.getByTestId("drawer-send-status").textContent).toBe(sendCopy.replied);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("shows a refused send beside its step, not only at the top of the drawer", async () => {
    const actions = actionsMock();
    actions.sendEmail.mockResolvedValue({ error: sendCopy.refused.cap });
    render(<PersonDrawer person={{ ...approved(), sendOffers: { email1: { kind: "send" } } }} closeHref="/c" actions={actions} onChanged={vi.fn()} />);
    const item = screen.getAllByTestId("drawer-step").find((row) => row.dataset.step === "email1")!;
    if (within(item).getByTestId("drawer-step-toggle").getAttribute("aria-expanded") === "false") fireEvent.click(within(item).getByTestId("drawer-step-toggle"));
    await act(async () => {
      fireEvent.click(within(item).getByRole("button", { name: sendCopy.send }));
    });
    expect(within(item).getByTestId("drawer-send-note").textContent).toBe(sendCopy.refused.cap);
    expect(screen.getByTestId("drawer-alert").textContent).toBe("");
  });

  it("keeps Copy on an approved email, with the card's greeting and sign-off around the body", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<PersonDrawer person={{ ...approved(), sendOffers: { email1: { kind: "not_due", from: "2026-10-12" } } }} closeHref="/c" actions={actionsMock()} onChanged={vi.fn()} />);
    const item = screen.getAllByTestId("drawer-step").find((row) => row.dataset.step === "email1")!;
    if (within(item).getByTestId("drawer-step-toggle").getAttribute("aria-expanded") === "false") fireEvent.click(within(item).getByTestId("drawer-step-toggle"));
    expect((within(item).getByTestId("send-from") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(within(item).getByRole("button", { name: /copy/i }));
    });
    const envelope = emailCard("d-email1").envelope!;
    expect(writeText).toHaveBeenCalledWith(`${envelope.greeting}\n\nComplaints arrive late.\n\n${envelope.signOff}`);
  });
});

describe("Ready to send", () => {
  const item = (over: Partial<Ready["items"][number]> = {}): Ready["items"][number] => ({
    campaignId: "c1",
    campaignName: "Claims leaders",
    campaignPersonId: "p1",
    name: "Avery Dunmore",
    company: "Ardent",
    step: "email1",
    due: "2026-10-05",
    subject: "Calls behind complaints",
    offer: { kind: "send" },
    ...over,
  });

  it("lists what is due first with its Send, sends through the server, and shows the list as it now stands", async () => {
    const after: Ready = { items: [item({ step: "email2", due: "2026-10-12", subject: null, offer: { kind: "not_due", from: "2026-10-12" } })], sentToday: 5, mailbox: true };
    const send = vi.fn(async () => ({ ready: after, note: sendCopy.sent, warn: false }));
    render(<ReadyToSend initial={{ items: [item()], sentToday: 4, mailbox: true }} send={send} />);
    expect(screen.getByTestId("ready-sent-today").textContent).toBe("4 of 30 sent today");
    expect(screen.getByTestId("ready-item").textContent).toContain("Email 1 · Calls behind complaints · Claims leaders · Due Mon 5 Oct");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: sendCopy.send }));
    });
    expect(send).toHaveBeenCalledWith({ personId: "p1", step: "email1" });
    expect(screen.getByTestId("ready-note").textContent).toBe(sendCopy.sent);
    expect(screen.getByTestId("ready-sent-today").textContent).toBe("5 of 30 sent today");
    expect(screen.getByRole("button", { name: "Send from Mon 12 Oct" })).toBeDefined();
  });

  it("says when nothing is waiting", () => {
    render(<ReadyToSend initial={{ items: [], sentToday: 0, mailbox: false }} send={vi.fn()} />);
    expect(screen.getByText(sendCopy.ready.empty)).toBeDefined();
  });
});

describe("Your email look", () => {
  const look = { font: "Aptos" as const, fontSize: 11, signature: "<p>Sam</p>" };

  it("starts from the saved look, replaces a pasted signature with the server's sanitised one, and previews in a sandboxed frame", async () => {
    const preview = vi.fn(async () => ({ preview: "<div>new</div>", signature: "<p><b>Sam Carter</b></p>" }));
    render(<EmailLookCard initial={look} initialPreview="<div>saved</div>" save={vi.fn()} preview={preview} />);
    const box = screen.getByRole("textbox", { name: emailLookCopy.signature });
    expect(box.innerHTML).toBe("<p>Sam</p>");
    const frame = screen.getByTitle(emailLookCopy.preview) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("<div>saved</div>");

    const pasted = `<p onclick="x()"><b>Sam Carter</b></p><script>alert(1)</script>`;
    await act(async () => {
      fireEvent.paste(box, { clipboardData: { getData: (type: string) => (type === "text/html" ? pasted : "") } });
    });
    await waitFor(() => expect(box.innerHTML).toBe("<p><b>Sam Carter</b></p>"));
    expect(preview).toHaveBeenCalledWith({ font: "Aptos", fontSize: 11, signature: pasted });
    expect(frame.getAttribute("srcdoc")).toContain("<div>new</div>");
  });

  it("saves the font, size and what the box holds, and shows what the server stored", async () => {
    const save = vi.fn(async () => ({ look: { font: "Georgia" as const, fontSize: 12, signature: "<p>Stored</p>" }, preview: "<div>stored</div>" }));
    render(<EmailLookCard initial={look} initialPreview="" save={save} preview={vi.fn(async () => ({ preview: "", signature: "" }))} />);
    fireEvent.change(screen.getByLabelText(emailLookCopy.font), { target: { value: "Georgia" } });
    fireEvent.change(screen.getByLabelText(emailLookCopy.size), { target: { value: "12" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: emailLookCopy.save }));
    });
    expect(save).toHaveBeenCalledWith({ font: "Georgia", fontSize: 12, signature: "<p>Sam</p>" });
    expect(screen.getByRole("textbox", { name: emailLookCopy.signature }).innerHTML).toBe("<p>Stored</p>");
    expect(screen.getByText(emailLookCopy.saved)).toBeDefined();
  });

  it("refuses a drop into the signature box", () => {
    render(<EmailLookCard initial={look} initialPreview="" save={vi.fn()} preview={vi.fn()} />);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    screen.getByRole("textbox", { name: emailLookCopy.signature }).dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
  });
});
