export type FileEntry = {
  path: string;
  name: string;
  parent_path: string;
  file_kind: string;
};

export type VaultInfo = {
  root: string;
  project_version: string;
  scanned: number;
  unchanged: number;
  updated: number;
  removed: number;
  full_rebuild: boolean;
  file_count: number;
  task_count: number;
  link_count: number;
};

export type VaultMigration = {
  id: string;
  action: string;
  remaining: number;
};

export type VaultOpenPlan = {
  rebuild: boolean;
  action: string;
  migrations: VaultMigration[];
};

export type VaultOpenProgress = {
  phase: "scan" | "index" | "resolve";
  done: number;
  total: number;
  path: string | null;
};

export type VaultChangeEvent = {
  scanned: number;
  updated: number;
  removed: number;
  paths: string[];
};

export type OpenFile = {
  path: string;
  content: string;
};

export type MediaFile = {
  path: string;
  mime: string;
  data: string;
};

export type AttachmentRow = {
  path: string;
  name: string;
  file_kind: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  reference_count: number;
  orphaned: boolean;
  text_indexed: boolean;
};

export type UserVimrc = {
  path: string;
  content: string;
  sourced_paths: string[];
  source_warnings: string[];
};

export type ViewMode = "source" | "live" | "preview" | "split";

export type TaskRow = {
  path: string;
  task_id: number;
  status: string;
  status_char: string;
  text: string;
  raw_line: string;
  line: number;
  completed: boolean;
  due: string | null;
  scheduled: string | null;
  priority: string | null;
  recurrence: string | null;
  tags: string[];
};

export type TaskScope = {
  folders: string[];
  tags: string[];
  property: string;
};

export type GitEntry = {
  status: string;
  path: string;
  conflicted: boolean;
};

export type GitStatus = {
  available: boolean;
  repository: boolean;
  branch: string | null;
  entries: GitEntry[];
  operation: string | null;
};

export type GitSyncStatus = {
  remote: string | null;
  upstream: string | null;
  remote_url: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
};

export type GitCommit = {
  hash: string;
  short_hash: string;
  author: string;
  timestamp: string;
  subject: string;
};

export type GitBranches = {
  current: string | null;
  branches: string[];
};

export type GitCommitDetails = {
  hash: string;
  author: string;
  author_email: string;
  timestamp: string;
  subject: string;
  body: string;
  parents: string[];
  patch: string;
};

export type GitConflictSides = {
  path: string;
  ours: string | null;
  theirs: string | null;
  base: string | null;
  working: string | null;
};

export type SearchResult = {
  path: string;
  title: string;
  snippet: string;
  line: number | null;
  rank: number;
};

export type GraphNode = {
  path: string;
  title: string;
  tags: string[];
};

export type GraphEdge = {
  source: string;
  target: string;
  embeds: boolean;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type LinkHealthNote = {
  path: string;
  title: string;
};

export type LinkPlaceholder = {
  source: string;
  target: string;
  count: number;
};

export type LinkHealth = {
  orphans: LinkHealthNote[];
  placeholders: LinkPlaceholder[];
};

export type NoteLinkRef = {
  path: string;
  title: string;
  target: string;
  heading: string | null;
  block: string | null;
  display: string | null;
  embed: boolean;
  resolved: boolean;
};

export type NoteHeading = {
  level: number;
  text: string;
  line: number;
};

export type UnlinkedMention = {
  path: string;
  title: string;
  snippet: string;
  line: number | null;
  term: string;
};

export type NoteContext = {
  path: string;
  title: string;
  aliases: string[];
  tags: string[];
  headings: NoteHeading[];
  backlinks: NoteLinkRef[];
  outgoing: NoteLinkRef[];
  unlinked: UnlinkedMention[];
};

export type VaultTag = {
  tag: string;
  count: number;
};

export type TagPage = {
  path: string;
  title: string;
};
