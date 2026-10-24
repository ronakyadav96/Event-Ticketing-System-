/**
 * Chat contract with the AI service (ai-service/app/api/schemas.py).
 * The server owns all booking state; the client only renders it.
 */

export interface EventCard {
  id: string;
  title?: string | null;
  category?: string | null;
  venue?: string | null;
  city?: string | null;
  price?: number | null;
  currency?: string;
  start_date?: string | null;
  end_date?: string | null;
  show_times?: string[];
  description?: string | null;
  image_url?: string | null;
  available_seats?: number | null;
  rating?: number | null;
  /** False when the event's run has ended (no bookable shows). */
  upcoming?: boolean | null;
}

export type BookingStage =
  | 'IDLE'
  | 'SELECT_VENUE'
  | 'SELECT_DATE'
  | 'SELECT_SHOWTIME'
  | 'SELECT_QUANTITY'
  | 'SELECT_SEATS'
  | 'REVIEW'
  | 'PAYMENT_PENDING'
  | 'COMPLETED';

export interface PaymentView {
  status?: string | null;
  /** Present only while a real Stripe checkout is open. */
  payment_url?: string | null;
  session_id?: string | null;
  expires_at?: string | null;
  /** Smallest currency unit (paise), as charged by Stripe. */
  amount_total?: number | null;
  currency?: string | null;
}

export interface TicketView {
  ticket_id: string;
  booking_id?: string | null;
}

export interface BookingView {
  stage: BookingStage;
  event?: EventCard | null;
  date?: string | null;
  time?: string | null;
  show_at?: string | null;
  quantity?: number | null;
  seats: string[];
  unit_price?: number | null;
  total_price?: number | null;
  options: Record<string, any>;
  payment?: PaymentView | null;
  ticket?: TicketView | null;
}

export interface SeatMap {
  rows: { row: string; seats: string[] }[];
  unavailable: string[];
  selected: string[];
  show_at?: string | null;
}

/** Where the app shows an answer: the explore page (search results) or an event / its booking page. */
export interface AppView {
  type: 'explore' | 'event';
  params?: Record<string, string | number>;
  event_id?: string | null;
  action?: 'details' | 'book' | null;
}

export interface ChatResponse {
  conversation_id: string;
  request_id: string;
  response: string;
  intent?: string | null;
  agent?: string | null;
  events: EventCard[];
  quick_replies: string[];
  booking: BookingView;
  seat_map?: SeatMap | null;
  faq_sources: { source: string; title?: string; section?: string; score?: number }[];
  view?: AppView | null;
  /** Reply language: 'en' or 'hi' (Hinglish). */
  language?: string | null;
  error?: string | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: Date;
  events?: EventCard[];
  seatMap?: SeatMap | null;
  /** Ticket confirmed by the server on this turn (snapshot for the transcript). */
  ticket?: TicketView | null;
  isError?: boolean;
  /** 'login': the assistant needs a signed-in user; the UI offers a sign-in button. */
  action?: 'login' | null;
  /** The app page this answer was shown on (re-openable from the transcript). */
  view?: AppView | null;
}

export interface ConversationSummary {
  id: string;
  title?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface StoredMessage {
  id: number;
  role: string;
  content: string;
  timestamp?: string | null;
  metadata: Record<string, any>;
}

export const IDLE_BOOKING: BookingView = { stage: 'IDLE', seats: [], options: {} };
