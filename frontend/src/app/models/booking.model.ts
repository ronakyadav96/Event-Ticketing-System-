// src/app/models/booking.model.ts
// Strict interfaces for booking entities and API payloads.

export interface Booking {
  _id?: string;
  id?: string;
  ticketId: string;
  user?: string | { _id: string; name?: string; email?: string };
  event: any; // Event reference or populated Event object
  eventId?: string;
  name: string;
  email: string;
  seats: number;
  registrationTemplate?: string;
  registrationData?: Record<string, any>;
  paymentStatus?: 'PENDING' | 'PAID' | 'FAILED';
  stripeSessionId?: string | null;
  stripePaymentIntentId?: string | null;
  showAt?: string | Date | null;
  bookedAt?: string | Date;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  [key: string]: any;
}

export interface CreateBookingPayload {
  eventId: string;
  name?: string;
  email?: string;
  seats: number;
  showAt?: string | Date | null;
  promotionId?: string | null;
  promotionCode?: string | null;
  discountAmount?: number;
  finalAmount?: number;
  registrationTemplate?: string;
  registrationData?: Record<string, any>;
  [key: string]: any;
}

export interface CheckoutSessionPayload {
  eventId: string;
  seats?: number;
  quantity?: number;
  ticketName?: string;
  unitAmount?: number;
  currency?: string;
  showAt?: string | Date | null;
  name?: string;
  email?: string;
  promotionId?: string | null;
  promotionCode?: string | null;
  discountAmount?: number;
  finalAmount?: number;
  registrationTemplate?: string;
  registrationData?: Record<string, any>;
  successUrl?: string;
  cancelUrl?: string;
  [key: string]: any;
}

export interface CheckoutSessionResponse {
  url: string;
  id?: string;
  sessionId?: string;
  [key: string]: any;
}

export interface BookingsPagedResponse {
  data: Booking[];
  total?: number;
  page?: number;
  limit?: number;
  totalPages?: number;
  [key: string]: any;
}
