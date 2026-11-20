interface UpdateStatus {
  state: "idle" | "unsupported" | "checking" | "latest" | "available" | "downloading" | "ready" | "error";
  version?: string;
  percent?: number;
  message?: string;
  checkedAt?: number;
}

// Present only when Folio runs as the desktop app (see electron/preload.cjs).
interface FolioDesktop {
  /** `note` says where a converted Word document's PDF was saved. */
  onOpenFile(callback: (name: string, data: Uint8Array, note?: string, filePath?: string) => void): () => void;
  onConverting(callback: (name: string) => void): () => void;
  onOpenFailed(callback: (message: string) => void): () => void;
  /** Converts a Word document (.doc, .docx) to PDF; the result arrives through onOpenFile. */
  openDocument(file: File): Promise<void>;
  /** Returns the disk path for a user-picked or dropped File, or "". */
  getPathForFile(file: File): string;
  ready(): Promise<boolean>;
  fetchPdf(url: string): Promise<{ name: string; data: Uint8Array }>;
  getAppInfo(): Promise<{ version: string; mode: "development" | "portable" | "installed" | "appimage" | "package"; location: string; platform: string;
    /** True when updates are announced with a download link instead of installed (unsigned macOS builds). */
    notifyOnly: boolean }>;
  /** "win32", "darwin", or "linux". */
  platform: string;
  /** Opens the releases page (macOS, where updates are downloaded manually). */
  openDownload(): Promise<void>;
  openInstallation(): Promise<string>;
  setTheme(theme: string): void;
  installUpdate(): void;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  checkForUpdates(): void;
  getAutoUpdateEnabled(): Promise<boolean>;
  setAutoUpdateEnabled(enabled: boolean): Promise<boolean>;
  ai: FolioAi;
  recent: FolioRecent;
}

interface DesktopRecentEntry {
  id: string;
  name: string;
  size: number;
  pages: number;
  openedAt: number;
  lastPage: number;
  thumb: string;
  filePath?: string;
}

interface FolioRecent {
  list(): Promise<DesktopRecentEntry[]>;
  get(id: string): Promise<DesktopRecentEntry | null>;
  read(id: string): Promise<{ name: string; data: Uint8Array; filePath?: string } | null>;
  save(entry: DesktopRecentEntry, bytes?: Uint8Array | null, keepIds?: string[]): Promise<boolean>;
  update(id: string, patch: { lastPage?: number; thumb?: string }): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  clear(): Promise<boolean>;
}

interface AiStatus {
  chatgpt: { connected: boolean; email: string; name: string; welcomeSeen: boolean; encrypted: boolean };
  claude: { installed: boolean; loggedIn: boolean; version?: string; subscription?: boolean; authMethod?: string };
  gemini: { available: boolean; mode: "api" | "cli" | "none"; cli?: "agy" | "gemini"; installed: boolean; loggedIn: boolean; version?: string };
}

interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

interface AiEvent {
  id: string;
  type: "delta" | "done" | "error";
  text?: string;
  message?: string;
  code?: string;
  link?: string;
}

interface FolioAi {
  status(): Promise<AiStatus>;
  signInChatGPT(): Promise<{ ok: boolean; status?: AiStatus["chatgpt"]; error?: string }>;
  signOutChatGPT(): Promise<AiStatus["chatgpt"]>;
  chatgptWelcomeSeen(): Promise<boolean>;
  chatgptModels(): Promise<{ ok: boolean; models?: { id: string; name: string }[]; error?: string; code?: string }>;
  recheckClaude(): Promise<AiStatus["claude"]>;
  recheckGemini(): Promise<AiStatus["gemini"]>;
  ask(request: { id: string; provider: "chatgpt" | "claude" | "gemini"; model: string; instructions: string; messages: AiMessage[] }): Promise<boolean>;
  cancel(id: string): Promise<boolean>;
  onEvent(callback: (event: AiEvent) => void): () => void;
}

interface Window {
  folioDesktop?: FolioDesktop;
}
