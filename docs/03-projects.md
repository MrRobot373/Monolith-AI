# Projects

A project keeps the chats, files and instructions for one piece of work together, in the spirit of ChatGPT Projects, but built for a private, multi-user workspace and for low resource use.

## What a project has

| Part | Behaviour |
|---|---|
| **Instructions** | Added to every chat in the project. They **replace** each person's personal custom instructions inside the project. |
| **Sources** | Uploaded files, pasted text (stored as Markdown) and saved answers. Library documents can be linked too. Every chat in the project can use them **without attaching**. |
| **Project memory** | When answering, the assistant also searches earlier chats in the same project: the user's own and those shared to the project. It uses Postgres full-text search, so no extra model is needed. Recalled passages are cited like documents ("Earlier chat in this project"). |
| **Chats** | Chats started in a project live there, not in Recents. Existing chats can be moved in or out. |

## Sharing

- **Visibility:** *private* (the owner plus invited people) or *workspace* (everyone in the workspace can open it and chat).
- **Roles:**
  - **owner:** everything, including delete.
  - **edit:** instructions, sources and people.
  - **chat:** chat in the project and read its instructions and sources.
- Org admins and workspace admins can manage every project in their workspace.
- **Chats are private to their author.** The author can choose **Share to project**, which lets everyone with access read that chat (read-only) and lets project memory use it. Moving a chat out of the project stops sharing it.
- Linking a private library document to a project makes it readable by the project's people. It stays in the owner's library.

## Also in Phase A

- **⌘K search:** chat titles and message text (with snippet), documents and projects.
- **Archive:** hides a chat from the sidebar and project lists. **Settings → Archived chats** restores or deletes it. Replying to an archived chat restores it.
- **Save to project:** any answer can be saved as a project source.
- **Deleting a project** deletes its chats and project-only files. Linked library documents are kept.

## Resource use

Retrieval is the same as for Documents: full-text search first, plus vectors when the workspace has an embedding model (with task prefixes for models trained with them, such as EmbeddingGemma 2; changing the model re-indexes the workspace). Small source sets (≤14k characters) are passed whole. Project memory only uses full-text search.

## Phase B (done)

| Feature | Behaviour |
|---|---|
| **Source labels** | Any document or project source can be marked **Confirmed**, **Assumption** or **TBD**. Citations show the label. When an answer relies on an Assumption or TBD source, the model is told to say it isn't confirmed. |
| **Versions** | **Upload new version** on a project source, or mark a source as **replaced by** another. The old version stays for reference, but answers leave it out. It keeps its label, and **Make current again** undoes the replacement. |
| **Edit and branch** | Editing a message starts a new branch and keeps the old one. Regenerating adds another version of the answer. **‹ 1/2 ›** switches between versions, and the chat remembers the branch being shown (`chat.leaf_message_id`, `message.parent_id`). |
| **Temporary chat** | Toggled on a new chat. It stays out of Recents, search and project memory, and is deleted 24 hours after its last message. **Keep chat** saves it. |
| **Excel** | `.xlsx` and `.xlsm` files: every sheet is read, formula results included. Each sheet counts as one "page" in citations. |
| **Text files** | Text, Markdown, CSV and code in UTF-8 or UTF-16 (what Windows Notepad and Excel save as "Unicode"), told apart by the byte-order mark or, without one, by the bytes themselves. Control characters are dropped. |
| **OCR** | Images (PNG, JPEG, WebP, TIFF, BMP) and scanned PDF pages are read locally with Tesseract. The English model is bundled, so nothing is downloaded at runtime. `OCR_ENABLED=false` turns it off. |
| **Export** | A whole chat (the branch being shown) or one answer can be downloaded as **Word** (.docx, built on the server) or **Markdown**. **PDF** uses a print view and the browser's "Save as PDF". |

## Phase C (done): Work AI in projects

| Feature | Behaviour |
|---|---|
| **Project tasks** | **New task** on the project page opens Work AI in the project (`/app/work?project=…`). The agent follows the project's instructions and gets a copy of the project's current sources (replaced versions left out) in `project/` in its folder, with `project/README.md` listing each file's type and label. The copy is refreshed whenever the task's runtime starts, so follow-ups see new sources; the agent saves its own work outside `project/`. Up to 200 MB is copied. |
| **Tasks list** | The project page lists your tasks in the project and those others shared to it, with their status. The Work AI task list shows each task's project. |
| **Results back to the project** | In a project task, **Save to project** on a file (Files panel) adds it as a project source (supported types, up to 25 MB); on an answer, it saves the answer as a *saved answer* source. Both need edit access to the project. |
| **Sharing** | Tasks are private to their author. **Share to project** (task menu) lets everyone with access to the project open the task, its timeline and files, read-only: they can't send messages, approve steps, stop it or add files. Leaving the project, or the task being unshared, ends that. |
| **Connectors** | Project settings → **Connectors for Work AI tasks**: all the organization's connectors (default) or only the chosen ones. Each person still signs in to their own account. Aatmiq's connector proxy refuses the others too, not just the tool list. |
| **Schedules** | A schedule can name a project: each run is a task in that project. |
| **Access** | Starting a task in a project needs access to it (any role). Access is checked again whenever the runtime starts: someone removed from the project keeps their task, without the project's instructions, files or connector choice. Deleting a project leaves its tasks and schedules with their owners, outside any project. |

Not yet: project memory doesn't search task timelines (only chats), and the copies in `project/`
aren't kept in sync while a task runs.
