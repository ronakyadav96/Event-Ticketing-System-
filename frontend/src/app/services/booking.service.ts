import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from '../auth/auth.service';
import {
  Booking,
  CreateBookingPayload,
  CheckoutSessionPayload,
  CheckoutSessionResponse,
  BookingsPagedResponse,
} from '../models/booking.model';

@Injectable({
  providedIn: 'root',
})
export class BookingService {
  private readonly API = `${environment.apiUrl}/api/bookings`;
  private readonly PAYMENTS_API = `${environment.apiUrl}/api/payments`;

  constructor(
    private http: HttpClient,
    private authService: AuthService
  ) {}

  private getAuthHeaders(): { headers: HttpHeaders } {
    const token = this.authService.getToken();
    return {
      headers: new HttpHeaders({
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }),
    };
  }

  createBooking(data: CreateBookingPayload): Observable<Booking> {
    return this.http.post<Booking>(this.API, data, this.getAuthHeaders());
  }

  addBooking(data: CreateBookingPayload): Observable<Booking> {
    return this.createBooking(data);
  }

  createCheckoutSession(data: CheckoutSessionPayload): Observable<CheckoutSessionResponse> {
    return this.http.post<CheckoutSessionResponse>(
      `${this.PAYMENTS_API}/create-checkout-session`,
      data,
      this.getAuthHeaders()
    );
  }

  createStripeCheckout(data: CheckoutSessionPayload): Observable<CheckoutSessionResponse> {
    return this.createCheckoutSession(data);
  }

  getByTicketId(ticketId: string): Observable<Booking> {
    return this.http.get<Booking>(`${this.API}/ticket/${encodeURIComponent(ticketId)}`, this.getAuthHeaders());
  }

  getMyBookings(): Observable<Booking[]> {
    return this.http.get<Booking[]>(`${this.API}/my`, this.getAuthHeaders());
  }

  getAllBookings(params?: { page?: number; limit?: number }): Observable<BookingsPagedResponse> {
    let httpParams = new HttpParams();
    if (params?.page) httpParams = httpParams.set('page', String(params.page));
    if (params?.limit) httpParams = httpParams.set('limit', String(params.limit));

    return this.http.get<BookingsPagedResponse>(this.API, {
      ...this.getAuthHeaders(),
      params: httpParams,
    });
  }

  deleteBooking(id: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`${this.API}/${encodeURIComponent(id)}`, this.getAuthHeaders());
  }
}
