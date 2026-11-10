// Wire DTOs mirror frontend/admin-web/src/domain.ts; no client implementation imports.
export type PageId =
  "dashboard" | "users" | "content" | "battles" | "analytics";
export type SkillId = "vocabulary" | "grammar" | "listening" | "reading";
export type ContentStatus = "draft" | "published" | "archived";
export type UserStatus = "active" | "banned" | "deleted";
export type Difficulty = "easy" | "medium" | "hard";
export type BattleStatus = "ongoing" | "completed" | "abandoned";
export type BattleMode = "quick" | "daily" | "private";

export interface AdminProfile {
  id: string;
  name: string;
  email: string;
  role: "administrator";
}
export interface UserRecord {
  id: string;
  code: string;
  name: string;
  email: string;
  status: UserStatus;
  createdAt: number;
  updatedAt: number;
  rating: number;
  coins: number;
  reason?: string;
}
export interface Category {
  id: SkillId;
  name: string;
  description: string;
  status: ContentStatus;
}
export interface Topic {
  id: string;
  categoryId: SkillId;
  title: string;
  description: string;
  status: ContentStatus;
}
export interface Lesson {
  id: string;
  topicId: string;
  title: string;
  description: string;
  difficulty: Difficulty;
  status: ContentStatus;
}
export interface QuestionRecord {
  id: string;
  code: string;
  categoryId: SkillId;
  topicId: string;
  lessonId: string;
  prompt: string;
  options: {id: string; text: string}[];
  correctOptionId: string;
  explanation: string;
  passage: string;
  audioUrl: string;
  audioText: string;
  difficulty: Difficulty;
  status: ContentStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}
export interface BattleRecord {
  id: string;
  code: string;
  player1: string;
  player2: string;
  player1Name: string;
  player2Name: string;
  score1: number;
  score2: number;
  status: BattleStatus;
  mode: BattleMode;
  categoryId: SkillId | "mixed";
  startedAt: number;
  endedAt: number | null;
  logs: {id: string; at: number; type: string; message: string}[];
}
export interface Activity {
  id: string;
  userId: string;
  text: string;
  type: "battle" | "lesson" | "user";
  at: number;
  categoryId: SkillId | "mixed";
  answered: number;
  correct: number;
  completed: boolean;
  userName?: string;
}
export interface AdminNotification {
  id: string;
  title: string;
  body: string;
  at: number;
  read: boolean;
  page: PageId;
}
export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string;
  at: number;
  reason: string;
}
export interface DemoState {
  schemaVersion: 1;
  profile: AdminProfile;
  users: UserRecord[];
  categories: Category[];
  topics: Topic[];
  lessons: Lesson[];
  questions: QuestionRecord[];
  questionHistory: Record<string, QuestionRecord[]>;
  battles: BattleRecord[];
  activities: Activity[];
  notifications: AdminNotification[];
  audit: AuditEntry[];
}
export interface DateRange {
  from: string;
  to: string;
}
export interface ListQuery {
  q?: string;
  status?: string;
  categoryId?: string;
  difficulty?: string;
  mode?: string;
  page?: number;
  pageSize?: number;
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface Overview {
  totalUsers: number;
  newUsers: number;
  activeUsers: number;
  completedBattles: number;
  completedLessons: number;
  growth: {users: number | null; active: number | null; battles: number | null};
  series: {
    date: string;
    users: number;
    previous: number;
    lessons: number;
    battles: number;
    active: number;
  }[];
  categories: {
    id: SkillId;
    name: string;
    lessons: number;
    battles: number;
    answered: number;
    correct: number;
    completed: number;
    started: number;
  }[];
  accuracy: number | null;
  completion: number | null;
  recent: Activity[];
  asOf: number;
}
export interface BattleDetail {
  battle: BattleRecord;
  player1: UserRecord;
  player2: UserRecord;
}
export interface Catalog {
  categories: Category[];
  topics: Topic[];
  lessons: Lesson[];
}
export interface CsvReport {
  filename: string;
  columns: string[];
  rows: (string | number)[][];
}
export type QuestionInput = Omit<
  QuestionRecord,
  "id" | "code" | "version" | "createdAt" | "updatedAt"
>;
export type UserInput = Pick<UserRecord, "name" | "email"> & {
  password?: string;
};
export type ContentInput = {
  kind: "category" | "topic" | "lesson";
  id?: string;
  title: string;
  description: string;
  status: ContentStatus;
  categoryId?: SkillId;
  topicId?: string;
  difficulty?: Difficulty;
};
