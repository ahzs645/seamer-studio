# Persistent sharing and detached workspaces

Seamer supports a static installation for on-device editing and a Node server profile for accounts, persistent shared documents and chat. Server features use the same origin as the editor; static installations display an explicit availability message in Share.

## Run the server

```sh
pnpm build:server
SEAMER_DATA_DIR=/absolute/private/seamer-data ORIGIN=http://localhost:3000 BODY_SIZE_LIMIT=13M node server-build
```

For a public installation, set `ORIGIN` to the HTTPS origin served by your reverse proxy. Keep `SEAMER_DATA_DIR` outside the public/static directory on persistent storage. The generated server is a **single-process** deployment: its transaction queue serializes writes to atomically replaced JSON account/session and document-history files. Do not run several server processes against the same data directory. Back up the complete data directory, including `collaboration.json`, `document-*.json` and `version-*.json` files. A static build remains `pnpm build`.

The server requires an existing data directory to have mode 0700 and creates a new directory with that mode and data files with mode 0600. Passwords use salted scrypt hashes. Random session tokens are stored as SHA-256 hashes and sent in HttpOnly, SameSite=Strict cookies (Secure when using HTTPS), expire after seven days and are revoked on sign-out. JSON mutations require the exact origin. Sign-in/account creation are limited to ten attempts per minute per client address. Request bodies are streamed with a 12.1 MB budget; shared patterns have a 12 MB serialized-document budget. Configure the Node body limit as above to permit artwork-bearing documents within that budget.

## Share and work together

Open **Share** from the More controls or **Open sharing and collaboration** from the command palette. Register or sign in, choose **Share current document**, and grant an already registered collaborator an Editor or Viewer role by email. Copy the shared link; recipients must sign in and have membership. Only the owner manages access. Viewers can read and chat; the server rejects their document writes. Removing a member revokes document, version and chat access.

Editing an attached shared document publishes after a short pause. Other attached editors receive changes and chat through two-second live polling, including while the Share panel is closed. Every accepted save creates a server revision, retaining the most recent 50 revisions. Changes are compared against the expected revision: a simultaneous edit returns a conflict instead of replacing someone else's work. The local draft remains available. Resolve a conflict by loading the server version or sharing the draft as a separate document. Restoring an earlier server version creates a new revision through the same publish flow. **Continue as local document** detaches the local draft from collaboration.

The collaboration server has its own access-controlled persistent storage. The older `/api/patterns` development store and local `isPublic` metadata do not grant access to shared documents.

## Detached windows

Choose **Draft window**, **Garment window** or **Specs window**, then **Detach** in More controls. Allow popups for this origin if the browser reports that the window was blocked. The new browser window hosts the real canvas, garment renderer or specification editor. Its edits are sent to the main workspace, which owns the canonical document and undo/redo. The main workspace broadcasts updated snapshots and rejects stale or read-only edits. Detached windows become read-only if their main workspace closes or disconnects. Close a detached window to dispose its channel; multiple windows can remain attached to one workspace.

Detached windows require BroadcastChannel support and the same browser origin. Each channel is scoped by a random per-window capability in the URL fragment. The channel does not replace server membership: the main window's active read-only role remains authoritative.
