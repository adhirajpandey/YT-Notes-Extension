import type { MessagePart } from './messageParts';
export interface MessageResponse {
  message: string;
}

export interface AuthLoginRequest {
  email: string;
  password: string;
}

export interface AuthRegisterRequest {
  email: string;
  name: string;
  password: string;
}

export interface GoogleLoginRequest {
  credential: string;
}

export interface LoginResponse {
  token: string;
}

export interface TokenResponse {
  message: string;
  token: string;
}

export interface TokenRevokeResponse {
  message: string;
}

export interface UserProfileRead {
  id: number;
  email: string;
  name?: string;
  profile_image_url?: string;
  ai_notes_enabled: boolean;
  token_exists: boolean;
  credits_balance: number;
  long_term_token?: string;
  created_at?: string;
}

export interface CreditProduct {
  product_id: string;
  credits: number;
  name: string;
  price_inr: number;
  price_per_credit: number;
}

export interface CreditProductListResponse {
  products: CreditProduct[];
}

export interface UserProfileUpdate {
  name?: string;
  ai_notes_enabled?: boolean;
}

// Video Types
export interface VideoRead {
  id: number;
  video_id: string;
  title: string | null;
  transcript_available: boolean;
  metadata: VideoMetadata | null;
  summary: string | null;
  suggested_questions: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface VideoMetadata {
  title?: string;
  channel?: string;
  channel_url?: string;
  uploader?: string;
  uploader_url?: string;
  duration_string?: string;
  thumbnail?: string;
  view_count?: number;
  like_count?: number;
  upload_date?: string;
}

export interface VideoListParams {
  page?: number;
  per_page?: number;
  q?: string;
  sort?: 'created_at_desc' | 'created_at_asc' | 'title_asc' | 'title_desc';
}

export interface VideoSearchItem {
  video_id: string;
  title: string | null;
  metadata?: VideoMetadata | null;
}

export interface VideoListResponse {
  videos: VideoSearchItem[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

// Note Types
export interface NoteRead {
  id: number;
  video_id: string;
  user_id: number;
  timestamp: number;
  text: string;
  created_at: string; // ISO date string
  updated_at: string;
  generated_by_ai: boolean;
}

export interface NoteCreate {
  video_title?: string;
  timestamp: number;
  text: string;
  generated_by_ai?: boolean;
}

export interface NoteUpdate {
  text?: string;
  generated_by_ai?: boolean;
}

// Conversation Types
export interface ConversationRead {
  id: number;
  video_id: string;
  user_id?: number;
  created_at: string;
}

export interface ConversationCreate {
  video_id: string;
}

export interface MessageRead {
  parts: MessagePart[];
  id: number;
  conversation_id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface MessageCreate {
  message: string;
}
