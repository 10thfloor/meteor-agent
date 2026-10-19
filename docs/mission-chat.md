# Mission chat recipients

Mission chat is shared context, not a private direct message. The composer’s
**Ask Atlas** menu above the message chooses which crew agent answers or switches
to a **Crew note — no agent reply**. It defaults to the mission’s
primary agent and remembers explicit selections per account and mission on this
device. **Chat** in a crew row selects that agent and focuses the same composer;
**View work** remains its activity history.

Selecting an agent from `@` completion consumes the completion token and selects
the recipient, wherever the caret is. A newly typed leading `@Relay` also selects
Relay. Ordinary inline or quoted mentions do not schedule extra agents. A manual
recipient selection overrides an unchanged leading mention. Follow-ups retain
the chosen recipient; an agent speaking or handing off never changes it.

The recipient is sent as a participant ID, not inferred by the orchestrator.
`Agent.send(sessionId, text, { to })` forwards it through the framework. Explicit
unavailable recipients fail rather than falling back to the primary. The app
retains an unavailable selection with a recovery hint and blocks only new
submissions; Stop and approval controls remain usable. Sent-message metadata
shows the addressed agent.

**Crew note** never schedules work, including when it contains `@` mentions.
Plan context follows the selected recipient. Explicit **Run plan** actions use
the agents saved on the plan’s steps, not the chat recipient.

Each of a Mission's topics has its own chat and its own remembered recipient. The
same menu also chooses where the answer goes: **Reply in this topic**, or **Reply
in thread**, which keeps your message in the topic and answers it in a thread
beside the chat (`Agent.send(sessionId, text, { to, replyIn: 'thread' })`). A
thread's composer has its own menu, without that choice. See
[Topics and threads](topics-and-threads.md).

## Uploads in chat

The composer’s **Add** menu groups **Upload files**, **Choose mission file**, and
**Attach plan**. Attaching a plan adds context; starting it still requires an
explicit Run plan action. With the mission filesystem enabled, uploads go
directly to the mission Sprite's `/workspace` folder. When it is off, Add links
to mission filesystem setup instead. Uploads use existing filesystem permissions and never enable
code execution or grant an agent extra access. File contents are not stored in
Mongo; only request receipts and the paths shared in messages are retained there.

The composer shows queued, uploading, saved, and retry states. Typing stays
available while uploads finish; Send waits for all selected files to be ready.
Sending shares the paths with the selected agent (or posts a non-waking crew
note). Uploading alone never starts a turn. Clicking a saved filename opens it
in **Files**; removing its chip only removes it from the message, not the Sprite.

**Choose mission file** browses the existing Sprite tree and attaches a path
without uploading a second copy. Both upload and selection are scoped to the
account, mission, and environment that opened the picker.

Each file is limited to 5 MB or the lower configured file limit, with at most ten
references per message. Existing filenames are never overwritten; a collision
offers a new name. Unconfirmed writes are checked using the same request ID,
never automatically replayed. Upload state is scoped to the current local
account and mission and is not a persistent draft across app restarts.

Files remain ordinary filesystem inputs, not automatically parsed documents.
The addressed agent needs Mission files access; extracting a PDF or another
binary document may also require code access and an appropriate reader.

## Agent handoffs

Rostered agents in shared conversations can call
`handoff_to_agent({ agent, message })` to pass the conversation to a colleague.
This is distinct from delegation, which creates a child task. A handoff must be
the only tool call in its response. Its receipt and durable wake are committed
together and remain subject to mission membership, tool and relay budgets,
lease ownership, and Stop. The UI displays who handed off, who received it, and
the request, without debug JSON. Leading-mention routing remains supported for
older integrations, but structured handoffs are the preferred model action.

## Verification

App tests cover explicit-recipient transport and retries, per-mission preference
isolation, `@` completion and typed addresses, non-waking notes, plan-context
routing, unavailable recipients, accessible recipient/turn feedback, and readable
transcript attribution. Tests use isolated fixtures rather than paid providers.
