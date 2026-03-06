Full-screen meeting requirement (must match Google Meet feel)

When a user navigates to:

/meet/[token]

the meeting experience must be a true full-screen view, not embedded in a dashboard layout and not a small panel.

Hard requirements

The meeting UI must occupy 100% viewport (position: fixed; inset: 0; height: 100vh; width: 100vw;) and should not show surrounding app chrome (sidebar/topbar/etc).

Meeting page must render with its own layout that bypasses the normal dashboard shell (use a dedicated layout group like app/(meet)/meet/[token]/page.tsx or similar).

Provide a “Google Meet style” visual hierarchy:

video grid / stage dominates the page

controls float at bottom and auto-hide

right-side overlay panels for chat/AI (minimized by default)

Candidate pre-join screen (STRICT)

Before a candidate actually joins the room, show a pre-join setup screen (Meet-like), but with these strict rules:

Candidate cannot disable these before joining

Camera toggle must be disabled (cannot turn off)

Microphone toggle must be disabled (cannot turn off)

Screen share must be enabled and required

Candidate pre-join flow

Candidate opens link → sees pre-join screen

Candidate clicks “Allow camera & microphone” (browser permission prompt)

Candidate clicks “Start screen sharing” (browser getDisplayMedia)

Only after:

camera stream acquired

mic stream acquired

screen stream acquired
the Join now button becomes enabled

If candidate refuses permissions:

Show a blocking message: “Camera, microphone, and screen sharing are required to join.”

Provide retry buttons for each permission.

Candidate screen share display rule

Candidate’s own screen share preview must be hidden (do not render it in candidate UI to save space).

Candidate may see only:

their camera preview (optional)

interviewer video(s) once in call

Interviewers must see candidate screen share prominently.

Full-screen in-call UI behavior (Google Meet style)
Auto-hide controls

The bottom control bar (mic/cam/share/leave/end/chat/ai buttons) must:

Be visible initially on mouse movement

Auto-hide after ~2–3 seconds of inactivity

Reappear on mouse move / tap (for mobile)

Not take permanent layout space (overlay/floating)

Controls include:

Leave call (all participants)

End call (owner interviewer only)

Chat toggle

AI toggle (interviewers only)

Mic/cam/share controls

Candidate rules in-call:

mic/cam toggles are allowed or not? (follow previous requirements: candidates must allow cam/mic/share; do NOT expose “turn off mic/cam” unless explicitly permitted. Default: keep candidate controls minimal, but still let them mute if needed? If unclear, implement mute allowed but camera off disabled; keep share required.)

Interviewers can toggle mic/cam and share screen.

Right-side overlay panels (Chat + AI) — minimized by default
Chat panel behavior

Chat is minimized by default.

When opened:

It appears as a right-side overlay drawer on top of the meeting UI (not pushing layout).

It should be sized similar to Google Meet chat panel (approx 320–420px wide depending on viewport).

Should have a close (X) icon.

Should keep video stage visible behind it.

Chat messages persist (DB), but history visible only to interviewers after the meeting (as already specified).

AI panel behavior (interviewers only)

AI panel is also minimized by default.

When opened:

same right-side overlay behavior as chat

can be a separate tab switcher inside the drawer:

Tab 1: Chat

Tab 2: AI

OR two separate buttons that open different drawer content (either is fine)

Overlay & input UX

Panels must overlay the meeting without reflowing the stage.

While typing in chat, do not auto-hide controls aggressively; keep input usable.

Fullscreen & escape handling

The meeting UI should feel “app-like”:

Add optional “Enter fullscreen” button (uses Fullscreen API) for users who want true fullscreen.

Even without Fullscreen API, the meeting still occupies the whole viewport.

Implementation notes (to force correct layout)

Create a dedicated route group/layout that does not include the interviewer/candidate dashboard shells:

e.g. app/(meeting)/meet/[token]/layout.tsx with minimal HTML/body styling and no sidebars.

Add global styles for meeting mode:

prevent page scroll

ensure container fills viewport

Use React state + event listeners:

track last mouse movement

show/hide controls with timeout

Ensure accessibility basics:

ESC closes drawer

focus trap not required but nice

Final strictness summary (must obey)

Meeting page is full-screen, not embedded.

Candidate pre-join:

cannot disable cam/mic/share toggles (disabled UI)

must acquire camera+mic+screen streams before Join is enabled

In-call:

controls auto-hide and appear on mouse movement

chat minimized by default; opens as right overlay drawer

AI minimized by default; same overlay drawer behavior for interviewers

owner can end for all; end call control only for owner

## LLM Provider Configuration

The app supports two provider modes controlled by `AI_PROVIDER`:

- `AI_PROVIDER=google`: uses Google AI Studio (`GOOGLE_AI_API_KEY`, `GOOGLE_AI_MODEL`)
- `AI_PROVIDER=local`: uses an Ollama-compatible HTTP server

For local LAN usage, set:

- `LOCAL_LLM_BASE_URL` (example: `http://192.168.1.45:11434`)
- `LOCAL_LLM_MODEL` (example: `gemma3:4b-it-qat`)
- optional:
  - `LOCAL_LLM_CHAT_ENDPOINT` (default `/api/chat`)
  - `LOCAL_LLM_GENERATE_ENDPOINT` (default `/api/generate`)
  - `LOCAL_LLM_TIMEOUT_MS` (default `60000`)

Provider choice is environment-driven only; there is no silent fallback between local and google.
