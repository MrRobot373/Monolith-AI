# Projects (Chat, Phase A)

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

Retrieval is the same as for Documents: full-text search first, plus vectors when the workspace has an embedding model. Small source sets (≤14k characters) are passed whole. Project memory only uses full-text search.

## Phase B (done)

| Feature | Behaviour |
|---|---|
| **Source labels** | Any document or project source can be marked **Confirmed**, **Assumption** or **TBD**. Citations show the label. When an answer relies on an Assumption or TBD source, the model is told to say it isn't confirmed. |
| **Versions** | **Upload new version** on a project source, or mark a source as **replaced by** another. The old version stays for reference, but answers leave it out. It keeps its label, and **Make current again** undoes the replacement. |
| **Edit and branch** | Editing a message starts a new branch and keeps the old one. Regenerating adds another version of the answer. **‹ 1/2 ›** switches between versions, and the chat remembers the branch being shown (`chat.leaf_message_id`, `message.parent_id`). |
| **Temporary chat** | Toggled on a new chat. It stays out of Recents, search and project memory, and is deleted 24 hours after its last message. **Keep chat** saves it. |
| **Excel** | `.xlsx` and `.xlsm` files: every sheet is read, formula results included. Each sheet counts as one "page" in citations. |
| **OCR** | Images (PNG, JPEG, WebP, TIFF, BMP) and scanned PDF pages are read locally with Tesseract. The English model is bundled, so nothing is downloaded at runtime. `OCR_ENABLED=false` turns it off. |
| **Export** | A whole chat (the branch being shown) or one answer can be downloaded as **Word** (.docx, built on the server) or **Markdown**. **PDF** uses a print view and the browser's "Save as PDF". |

## Later

- **Phase C:** project tasks and connectors, with Work AI.
