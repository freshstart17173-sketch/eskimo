# Blender node editor — UX audit for Eskimo's graph canvas

Requested directly: "look through the blender documentation and images to
look for anything in their node graph that should be stolen, this is a
nitpicking pass and you must be extremely anal about this. A slow
viewport, a jittery input, lack of ux polish in the form of hover states,
snap anticipation, all these little things, every single one should be
documented."

This is a documentation pass, not an implementation one. Every item below
was checked against Eskimo's actual current code (`src/components/
GraphPane.jsx`, `src/components/GraphNodes.jsx`, `src/styles.css`,
`@xyflow/react` v12.3.6's own defaults) — not assumed. Each gets a verdict:
**gap** (Blender does something Eskimo doesn't, and it plausibly should),
**already matches** (checked, no action), or **not applicable** (Blender
feature doesn't map to what Eskimo's graph actually is — a fixed set of
DJ-set nodes, not an arbitrary compute pipeline).

`docs.blender.org` blocks direct fetches from this environment (403) — the
Blender-side facts below come from Blender's own manual pages and community
sources via web search, cited inline.

---

## 1. Viewport feel — pan, zoom, momentum

### 1.1 Zoom-to-cursor
**Blender**: scroll-wheel zoom centers on the cursor position, not the
viewport center. ([Blender Manual — Navigation](https://docs.blender.org/manual/en/latest/editors/3dview/navigate/navigation.html))
**Eskimo**: `@xyflow/react`'s default wheel-zoom (d3-zoom under the hood)
already zooms toward the pointer, unmodified in `GraphPane.jsx`.
**Verdict**: already matches. No action.

### 1.2 Pan input
**Blender**: default pan is Shift+MMB-drag; the node editor specifically
can also map plain RMB-drag to pan. ([Blender Manual — Node Editor Navigating](https://docs.blender.org/manual/en/2.79/editors/node_editor/navigate.html))
**Eskimo**: `panOnDrag={false}` + `selectionOnDrag` means a plain drag on
empty canvas draws a selection box; panning requires **holding Shift**
while dragging (`panActivationKeyCode="Shift"`). This is a deliberate,
documented tradeoff (see the comment above it in `GraphPane.jsx`) made to
fix a real reported bug — plain-drag panning was fighting a right-click
menu dismissal with no way to undo it.
**Verdict**: gap, but a narrow one. The Shift-drag reasoning is sound and
shouldn't be undone. What's missing is a **second, non-conflicting pan
input**: middle-mouse-button drag. MMB is unclaimed by anything else in
this canvas (LMB drags/selects, RMB opens context menus, Shift+LMB pans),
costs nothing to add alongside the existing binding, and is the same
convention Blender, Figma, and most node/canvas tools all converge on for
"the button that only pans." A held Shift key for a long continuous pan
gesture is mildly awkward on a laptop; MMB removes that friction for
anyone with a mouse without touching the Shift-drag fallback for trackpad
users.
**Recommendation**: add `panOnDrag={[1]}` to React Flow's own prop (button
index 1 = middle mouse) — additive, doesn't require touching the
Shift-drag or selection-box logic at all. Low effort.

### 1.3 Zoom/pan smoothness under trackpad input
**Blender**: pinch-to-zoom and two-finger pan on a trackpad are smooth
because they go through OS gesture events, not synthesized wheel deltas.
**Eskimo**: inherits `@xyflow/react`'s d3-zoom wheel handling as-is — no
custom deceleration/easing added or removed here.
**Verdict**: not independently verifiable without a real trackpad in this
environment (this session's Playwright checks are all synthetic mouse
paths). Flagging as **untested, not confirmed-safe** rather than "already
matches" — worth a real spot-check with an actual trackpad if a report of
"jittery" panning/zooming ever comes in, since d3-zoom's wheel-delta
normalization is a known source of inconsistent feel across trackpad
drivers (Windows precision touchpad vs. macOS vs. Linux libinput all emit
different deltas for the same gesture).

### 1.4 Zoom range
**Blender**: effectively unbounded zoom in the node editor.
**Eskimo**: `minZoom={0.25}` / `maxZoom={2.5}` (`GraphPane.jsx`).
**Verdict**: not applicable — Eskimo's graphs are small (tens of songs,
not thousands of shader nodes), a bounded range is the right call for a
UI that's supposed to stay legible, not a missing feature.

---

## 2. Selection

### 2.1 Selection-box visual color
**Blender**: selection box uses the theme's own selection color, matching
the rest of the UI.
**Eskimo**: uses `@xyflow/react`'s **unmodified default** selection-box
style — `--xy-selection-background-color-default: rgba(0, 89, 220, 0.08)`
/ `--xy-selection-border-default: 1px dotted rgba(0, 89, 220, 0.8)`
(confirmed directly in `node_modules/@xyflow/react/dist/style.css`; no
override exists anywhere in `src/styles.css`). That's React Flow's stock
blue.
**Verdict**: real gap. The rest of this app just went through a full
visual-fidelity pass specifically to get *off* generic blue-accent UI
conventions and onto its own ink + single-pastel-accent language
(`--accent`, used for the multi-select ring itself — see
`.node-multi-selected` in `styles.css`). The one remaining stock-blue
element left on screen during a drag-select is the selection box itself,
and it's the most visible thing on screen for the duration of the
gesture.
**Recommendation**: override `--xy-selection-background-color` /
`--xy-selection-border` (or target `.react-flow__selection` directly) to
use `var(--accent)` at low opacity for the fill and a dotted `var(--ink)`
or `var(--accent)` border — matching the ring color nodes get once
actually selected, so the box and its result read as the same visual
language. Low effort, CSS-only.

### 2.2 Add-to-selection modifier key
**Blender**: Shift+click adds a single node to the current selection.
**Eskimo**: `elementsSelectable` is on with no `multiSelectionKeyCode`
override, so it uses `@xyflow/react`'s own default — **Meta on macOS,
Control elsewhere** (confirmed in the library's own type declarations,
`component-props.d.ts`) — not Shift. This does **not** conflict with
`panActivationKeyCode="Shift"` (verified: they're different, unrelated
props/keys), so there's no live bug here.
**Verdict**: already works as shipped, just via Ctrl/Cmd+click rather than
Shift+click. No action needed — matching Blender's exact keybinding isn't
a goal in itself; this app's existing convention (Ctrl/Cmd for the
add-to-selection modifier) is the standard one for the desktop OS a user
is actually running, which is more discoverable than copying Blender's
specific choice.

### 2.3 Selection-vs-hover visual clash
Already the very first bug fixed this session (`.node-card.state-selected
:hover, .node-card.state-selected.node-hovered` combined-shadow rule) —
included here only because it's the exact category of thing this audit
is looking for, and it's already handled. No further action.

---

## 3. Connection dragging — "snap anticipation"

This is the most direct hit against the user's own named example.

### 3.1 Valid/invalid target highlighting while dragging a wire
**Blender**: dragging a noodle from a socket highlights compatible target
sockets as you approach them — the target visibly grows/brightens before
you release, so you can tell you're about to make a valid connection
*before* letting go, rather than finding out only after the drop
succeeds or silently fails.
**Eskimo**: `@xyflow/react` ships this exact mechanism for free — it adds
`.connectingfrom` / `.connectingto` / `.valid` classes to handles during
an active connection drag (see the library's own connection-line
handling). **Confirmed nothing in `src/styles.css` styles any of these
classes** (grepped for `handle-connecting`, `handle-valid`, `.valid`,
`connectionline` — zero matches in `src/`). The socket dots
(`.graph-pane .react-flow__handle.node-socket`) have exactly one dynamic
state styled today: `.node-socket-active` (a *committed* wire, not a
drag-in-progress preview) plus the existing `:hover`/`.node-socket-
clickable`/`.node-socket-draggable` rules, which only fire for the
pointer's *own* hovered socket, not for candidate targets lighting up
while a connection drawn from elsewhere is in flight.
**Verdict**: genuine gap, and it's exactly the "snap anticipation" the
user named. Right now, dragging a wire toward a socket gives zero visual
feedback about whether that socket is a legal target until the drop
either connects or silently does nothing (`isValidConnection` rejects it).
Given `connectionRadius={40}` is already fairly generous (a drop doesn't
have to be pixel-perfect on the dot), the lack of any preview affordance
means a user gets the *forgiving hit-test* without the *visual confidence*
that should come with it — the two are supposed to work together.
**Recommendation**: style `.react-flow__handle.connectingto.valid` (grows
the dot / adds an ink ring, similar treatment to the existing hover-ring
math already in this file) and `.react-flow__handle.connectingto.invalid`
(a muted/red-tinted treatment) during an active connection drag. This is
CSS-only — no JS changes, since React Flow already computes and applies
these classes; nothing here has been wired to *look* like anything yet.
Medium effort (needs the same anti-overlap sizing care already documented
for the base socket dot, since a "grows on approach" state must not bleed
into an adjacent row at the current 23px socket-row spacing).

### 3.2 Auto-offset (dropping a node onto an existing wire)
**Blender**: dropping a node with one matching input and one matching
output directly onto an existing noodle automatically splices it into
that link and shifts neighboring nodes along an axis to make room.
([community-reported feature via search](https://developer.blender.org/T75809))
**Verdict**: not applicable. Eskimo's nodes are fixed one-per-song
entities placed by the user (or by Autoarrange) — there's no equivalent
of "a generic passthrough node that could be spliced into any wire."
Splicing a *song* into an existing transition would silently rewrite
someone's set structure in a way that has no clean analog to Blender's
pure-function node graphs. Not recommended.

### 3.3 Reroute nodes (Shift+RMB-drag across a noodle)
**Blender**: dragging with Shift+RMB across a noodle inserts a Reroute
node at that point, which can then be repositioned to bend a wire's
visual path without changing its logical connection.
**Verdict**: not applicable in the literal sense — Eskimo has no concept
of a routing-only node, and the existing fan-out math (`fannedBezierPath`
in `GraphPane.jsx`) already exists specifically to solve the *visual*
problem reroute nodes solve in Blender (multiple overlapping wires between
the same two points, or converging on the same target) without needing a
manual per-wire node. The underlying need is already met by different
means. No action.

### 3.4 "Snap to nearest node" complaints
**Blender**: a documented, load-bearing feature (auto-offset, above)
relies on snap-to-node detection during a drag, and it's been reported
directly in the research above as "unpredictable and not useful" by
Blender's own users.
**Verdict**: worth noting as a **cautionary example**, not a feature to
copy. If node-position snapping is ever added to Eskimo (see 4.1 below),
snapping to *other nodes'* positions/edges specifically is the one variant
Blender's own community flags as broken — grid-snapping only is the safer
version to build first.

---

## 4. Node/graph structure polish

### 4.1 Node-position grid snapping
**Blender**: node transforms can snap to an increment grid (toggle via
`/`, or hold Ctrl while dragging).
**Eskimo**: renders a visible dot grid (`<Background variant={
BackgroundVariant.Dots} gap={22} .../>`, `GraphPane.jsx`) but nodes have
**no snapping behavior at all** — `onNodeDragStop`/`onSelectionDragStop`
persist whatever raw pixel position the drag ended at. Confirmed no
grid-snap math anywhere in `graphLayout.js` or `GraphPane.jsx`.
**Verdict**: real, if minor, gap — and specifically the kind the user
asked to be nitpicked about. The dot grid visually implies a structured
lattice a designer expects nodes to align to (that's the entire reason
node editors render one instead of a blank canvas), but nothing in this
app currently honors that implication — two nodes dragged "close" to
aligned will sit 3px off from each other indefinitely, with no diagram-
tidiness benefit apart from running Autoarrange from scratch. Per the 3.4
caution above, node-to-node snapping specifically is the version to
avoid; grid-only snapping (round to the nearest 22px, i.e. `Math.round(x
/ 22) * 22`, matching the existing `gap={22}` background exactly) is
simple, predictable, and low-risk.
**Recommendation**: snap `onNodeDragStop`/`onSelectionDragStop`'s final
committed position to the 22px grid (not a live snap during the drag
itself — that fights free positioning while actively dragging, per
Blender's own optional/toggleable framing of this feature — just quantize
on release). Low-medium effort; must confirm it doesn't fight the
existing Autoarrange (dagre) layout math, which presumably produces its
own non-grid-aligned coordinates today.

### 4.2 Node header color-coding by category
**Blender**: node headers are color-coded by node type/category (Input,
Color, Vector, Shader, Converter, etc.) so you can tell a node's broad
role at a glance across a large, heterogeneous graph.
([Blender Manual — Node Parts](https://docs.blender.org/manual/en/latest/interface/controls/nodes/parts.html))
**Verdict**: not applicable. Eskimo's canvas has exactly three node
*types* (Song, Start, End) — Song nodes are the overwhelming majority,
and they're already color-differentiated by something more useful than a
fixed category color: the actual **cover-art-derived dominant color**
(`dominantColor.js`), which is per-song, not per-type, and already serves
the "tell nodes apart at a glance" job Blender's category colors do in a
graph made of many different node *kinds*. Category coloring would be a
regression here, not an upgrade — it doesn't map onto a graph that's
structurally homogeneous. No action.

### 4.3 Socket color-coding by data type
**Blender**: sockets are colored by the data type they carry (color,
vector, shader, value, etc.), and a same-type connection is easy to
visually confirm at a glance; connecting incompatible types (e.g. a
Shader socket to anything else) turns the wire red.
([Blender Shaders — Sockets](https://wannesmalfait.github.io/Blender-shaders/mnode/sockets.html))
**Verdict**: already deliberately, explicitly rejected earlier this
session — this is worth restating here since it's exactly the kind of
thing a Blender-comparison pass would otherwise re-flag. Eskimo's sockets
used to be colored per-type (None/Intro/Outro/Transition each had its own
`--socket-border`/`--socket-ring`) and were changed to plain hollow
circles, uniform across types, specifically because the mockup's own
correction (`docs/design/socket-redesign-v6.html`'s changelog) determined
type-color was visual noise once the row already carries a text label
naming its own type. Blender's case is different in kind: a shader graph
can have dozens of sockets on screen with no per-socket label space at
all, so color is the *only* affordance available; Eskimo's socket rows
always render alongside their own label. Correctly already not copied.

### 4.4 Invalid-connection feedback (red wire)
**Blender**: an attempted incompatible connection renders the wire red
before rejecting it.
**Eskimo**: `isValidConnection` (passed to `<ReactFlow>`) rejects a bad
connection outright — there's currently no distinct "you're hovering an
invalid target" visual at all (see 3.1 above, which covers both the valid
and invalid cases together). Not a separate item — folded into 3.1's
recommendation (style both `.valid` and `.invalid` connecting-handle
states, not just the valid one).

---

## 5. Discoverability — Node Wrangler-style power-user affordances

These are documented for completeness, but flagged as **explicitly
lower priority / likely not worth building** — Node Wrangler is itself a
*non-default, opt-in addon* in Blender, not core behavior, meaning even
Blender's own answer to "should every user get this" is no.

### 5.1 Link-drag search
**Blender**: dragging a wire out from an empty socket and releasing over
blank canvas opens a searchable menu to create and auto-connect a new
node of a compatible type, instead of just canceling the drag.
**Verdict**: partially applicable in spirit, not in mechanism. Eskimo
already has an equivalent entry point for "I don't have the node I want
yet" — the pane's own context menu / toolbar flows for adding a song —
but there's no drag-to-create shortcut specifically. Given Eskimo's nodes
represent real uploaded songs (not synthesizable function nodes), "create
a new compatible node" doesn't reduce to a generic action the way it does
in Blender — there's no such thing as conjuring a new song node without
picking a real song or uploading one. Low priority; the underlying need
doesn't map cleanly.

### 5.2 Ctrl+Shift+click "instant preview"
**Blender** (Node Wrangler): Ctrl+Shift+click on a node temporarily wires
its output to the final Material/World Output for an instant viewport
preview, without disturbing the node's real connections.
**Verdict**: not applicable — Eskimo's "preview" concept already exists
in a more directly useful form for this domain (playing a song, or the
transition-preview player built earlier this session in `AddAudio.jsx`),
gated behind an explicit, visible button rather than a hidden modifier-
click. A hidden gesture would be a strict discoverability regression here.

### 5.3 Quick-access shortcut menu (Shift+W)
**Blender** (Node Wrangler): a dedicated modal quick-menu for its own
commands.
**Verdict**: not applicable at Eskimo's current feature surface — there
aren't yet enough power-user-only graph commands to justify a dedicated
shortcut-menu layer distinct from the existing right-click context menus
(`ContextMenu` in `PerformPage.jsx`), which already serve that role.
Revisit if/when the command count grows enough that the context menu
itself gets crowded.

### 5.4 Minimap
**Blender**'s node editor has **no built-in minimap** — it's exclusively
a third-party addon ([Node Editor Minimap](https://5333164294926.gumroad.com/l/fpwyf),
[Node Minimap addon](https://pullusb.gumroad.com/l/node-minimap)), not
stock behavior, which is itself informative: even Blender's own core team
didn't consider it necessary for node-graph navigation. `@xyflow/react`
does ship a ready-made `<MiniMap>` component Eskimo isn't using.
**Verdict**: not applicable at Eskimo's current scale (tens of nodes, all
reachable via `fitView` + Autoarrange) — a minimap earns its screen-space
cost on graphs with hundreds+ of nodes where "fit everything on screen at
once and still read labels" stops being possible. Worth revisiting only
if/when real sets in the wild regularly outgrow one comfortable viewport.

### 5.5 Node muting (M key)
**Blender** (Node Wrangler): mutes a node, bypassing it in the graph
without deleting it or its connections.
**Verdict**: has a real conceptual analog worth naming even though it's
not being recommended for this pass — "temporarily disable a transition
without deleting its wiring" is exactly the kind of thing the *searchable
add/remove list* idea (raised earlier this session for the many-
transitions-same-song case, then deliberately scoped down to "just make
it random" per direct instruction) would have covered. Not reopening that
decision here — just noting the conceptual overlap for whoever reads this
later.

---

## Summary — concrete, scoped recommendations (in priority order)

1. **Style the connection-drag valid/invalid handle states** (§3.1) — the
   single most direct hit against "snap anticipation," CSS-only, uses
   classes React Flow already applies for free.
2. **Recolor the selection box** off React Flow's stock blue onto
   `var(--accent)`/`var(--ink)` (§2.1) — CSS-only, closes the last
   remaining stock-blue element after this session's whole visual-fidelity
   pass.
3. **Add middle-mouse-button pan** alongside the existing Shift-drag
   (§1.2) — one-line additive prop change, zero risk to the existing,
   deliberately-chosen Shift-drag/box-select split.
4. **Snap node positions to the 22px background grid on drag release**
   (§4.1) — makes the already-visible dot grid mean something; grid-only
   (not node-to-node — see §3.4's cited Blender complaint about exactly
   that variant), and only on drop, not live during the drag.

Everything else above (§1.3, §1.4, §2.2, §2.3, §4.2, §4.3, §4.4-folded-
into-§3.1, all of §5) is either already handled, already correctly
rejected with reasoning, or genuinely doesn't map onto what Eskimo's graph
actually is. None of the four recommendations above have been implemented
as part of this pass — this document is the research/audit deliverable
that was explicitly asked for; implementing any of them is a separate,
not-yet-authorized next step.
