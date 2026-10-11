/** Document-owned editor layout. Each pane occurs at most once in a binary split tree. */
export type WorkspacePaneId = '2d' | '3d' | 'specs';
export type WorkspaceDockNode =
  | { type: 'pane'; pane: WorkspacePaneId }
  | { type: 'split'; id: string; direction: 'horizontal' | 'vertical'; ratio: number;
      first: WorkspaceDockNode; second: WorkspaceDockNode };
export interface WorkspaceLayout { version: 1; root: WorkspaceDockNode }
