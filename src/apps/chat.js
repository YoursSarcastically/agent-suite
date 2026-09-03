/**
 * Chat - an ordinary conversation, running on your own machine.
 *
 * The odd one out here, deliberately. Every other app asks the model for a
 * decision that code downstream has to act on, so its output is constrained to
 * a schema and guaranteed to parse. A conversation has no consumer but the
 * person reading it, so this one streams plain text and constrains nothing.
 *
 * What it does share with the rest is where it runs. The transcript lives in
 * this browser and nowhere else - no account, no history synced to a server,
 * and nothing to delete from someone else's database when you clear it.
 */

import { el, clear } from "../dom.js";
import { markdown } from "../markdown.js";
import { chat } from "../runtime.js";
import { read, write, remove } from "../store.js";

const KEY = "chat:messages";

const SYSTEM =
  "You are a helpful assistant running locally in someone's web browser. Be direct and " +
  "concise: aim for a few sentences, and use a short list only when the answer genuinely " +
  "has parts. Do not pad, do not restate the question, and do not offer to continue. You " +
  "are running on a small model on the user's own hardware, so every token costs them " +
  "time they can see. If you do not know something, say so rather than guessing.";

const STARTERS = [
  "Explain WebGPU like I have ten minutes",
  "Help me name a side project",
  "What should I ask in a PM interview?",
];

export default {
  id: "chat",
  name: "Chat",
  icon: "chat",
  blurb: "A conversation that never leaves your computer",

  mount(root, ctx) {
    let messages = read(KEY, []);
    let streaming = null;

    const thread = el("div.thread");
    const input = el("textarea.field.composer-input", {
      rows: 1,
      placeholder: "Ask anything",
    });

    const sendBtn = el("button.btn.btn-primary", { onclick: send }, "Send");
    const stopBtn = el("button.btn", { hidden: true, onclick: () => streaming?.abort() }, "Stop");
    const clearBtn = el("button.btn.btn-ghost.btn-sm", { onclick: reset }, "Clear chat");

    // Enter sends, shift+enter breaks the line - the convention people already
    // have in their fingers from every other chat box.
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    input.addEventListener("input", grow);

    // The thread scrolls, not the page. That is what every chat app does, and it
    // is what makes a sticky composer and a reliable "pinned to bottom" possible.
    const scroller = el("div.scroller", {}, thread);

    root.append(
      el("div.chat-shell", {},
        scroller,
        el("div.composer", {},
          input,
          el("div.composer-row", {}, sendBtn, stopBtn, el("span.spacer"), clearBtn)))
    );

    render();
    scrollToEnd("auto");

    /* ---------------- sending ---------------- */

    async function send() {
      const text = input.value.trim();
      if (!text || streaming) return;

      messages.push({ role: "user", content: text });
      input.value = "";
      grow();
      render();
      scrollToEnd();

      // The assistant's bubble exists before the first token does, so the page
      // acknowledges the message instantly instead of sitting still for the
      // second or two before generation starts.
      const bubble = el("div.msg.msg-assistant", {}, el("div.msg-body"), el("span.caret"));
      thread.append(bubble);
      scrollToEnd();

      const body = bubble.querySelector(".msg-body");
      // Follow the reply only while the reader is already at the bottom. Yanking
      // someone back down while they are reading what scrolled past is the most
      // irritating thing a chat UI can do.
      let pinned = true;
      const watch = () => { pinned = atBottom(); };
      scroller.addEventListener("scroll", watch, { passive: true });

      streaming = new AbortController();
      sendBtn.hidden = true;
      stopBtn.hidden = false;
      input.disabled = true;

      try {
        await ctx.ensureModel?.();
        const { reply, tokensPerSecond, completionTokens } = await chat(messages, {
          modelId: ctx.modelId(),
          system: SYSTEM,
          // 800 tokens is eighty seconds of watching a caret at this speed.
          maxTokens: 400,
          signal: streaming.signal,
          // Render Markdown as it streams. Re-parsing the whole reply each token
          // is wasteful in principle and unmeasurable in practice next to the
          // ~100ms the model takes to produce the next one.
          onToken: (_, whole) => {
            body.innerHTML = markdown(whole);
            if (pinned) scrollToEnd("auto");
          },
        });

        if (reply.trim()) {
          messages.push({ role: "assistant", content: reply });
          write(KEY, messages);
          bubble.append(el("span.msg-meta", { text: `${tokensPerSecond} tokens/sec` }));
        }
        ctx.record?.({ completionTokens, tokensPerSecond });
      } catch (err) {
        if (err.name !== "AbortError") {
          body.textContent = `Something went wrong: ${err.message}`;
          bubble.classList.add("msg-error");
        }
      } finally {
        scroller.removeEventListener("scroll", watch);
        bubble.querySelector(".caret")?.remove();
        streaming = null;
        sendBtn.hidden = false;
        stopBtn.hidden = true;
        input.disabled = false;
        input.focus();
        render();
      }
    }

    function reset() {
      if (streaming) return ctx.toast("Stop the current reply first.");
      messages = [];
      remove(KEY);
      render();
    }

    /* ---------------- rendering ---------------- */

    function render() {
      clear(thread);

      if (!messages.length) {
        thread.append(el("div.chat-empty", {},
          el("h2", { text: "What can I help with?" }),
          el("p.muted", { style: { marginTop: "10px" },
            text: "This runs on your own machine. Nothing you type is sent anywhere." }),
          el("div.row", { style: { marginTop: "22px", justifyContent: "center" } },
            STARTERS.map((q) => el("button.btn.btn-sm", {
              onclick: () => { input.value = q; grow(); send(); },
            }, q)))));
        return;
      }

      for (const m of messages) {
        const body = el("div.msg-body");
        // The user's own text is shown as they typed it; only replies are Markdown.
        if (m.role === "assistant") body.innerHTML = markdown(m.content);
        else body.textContent = m.content;
        thread.append(el(`div.msg.msg-${m.role}`, {}, body));
      }
    }

    /** Grow the composer with its content, up to a point. */
    function grow() {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
    }

    /** Within a few pixels of the bottom counts as "at the bottom". */
    const atBottom = () =>
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;

    function scrollToEnd(behavior = "smooth") {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    }
  },
};
