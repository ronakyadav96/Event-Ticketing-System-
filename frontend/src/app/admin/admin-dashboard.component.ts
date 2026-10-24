// admin-dashboard.component.ts ✅ UPDATED (uses environment.apiUrl instead of localhost)
import { Component, OnInit } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClientModule, HttpClient, HttpHeaders } from '@angular/common/http';
import { RouterModule, Router } from '@angular/router';
import { AuthService } from '../auth/auth.service';

import { forkJoin, of } from 'rxjs';
import { catchError, finalize, timeout } from 'rxjs/operators';

import { environment } from '../../environments/environment';

type EventStatus = 'Upcoming' | 'Past' | 'Sold Out';

@Component({
  selector: 'app-admin-dashboard',
  standalone: true,
  imports: [CommonModule, DatePipe, FormsModule, HttpClientModule, RouterModule],
  templateUrl: './admin-dashboard.component.html',
  styleUrls: ['./admin-dashboard.component.css']
})
export class AdminDashboardComponent implements OnInit {
  events: any[] = [];
  bookings: any[] = [];
  users: any[] = [];

  loading = false;
  errorMsg = '';

  activeTab: 'events' | 'bookings' | 'users' = 'events';

  searchText = '';
  statusFilter: 'all' | 'upcoming' | 'past' | 'soldout' = 'all';

  // ✅ NO localhost
  private API = `${environment.apiUrl}/api/admin`;

  constructor(
    private http: HttpClient,
    private router: Router,
    private auth: AuthService
  ) {}

  ngOnInit(): void {
    console.log('[AdminDashboard] init');
    this.loadAll();
  }

  get headers() {
    const token = this.auth.getToken();
    return {
      headers: new HttpHeaders({
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      })
    };
  }

  loadAll() {
    this.loading = true;
    this.errorMsg = '';

    const events$ = this.http.get<any[]>(`${this.API}/events`, this.headers).pipe(
      timeout(8000),
      catchError((err) => {
        console.error('[AdminDashboard] events error:', err);
        this.errorMsg ||= 'Some dashboard data failed to load.';
        return of([] as any[]);
      })
    );

    const bookings$ = this.http.get<any[]>(`${this.API}/bookings`, this.headers).pipe(
      timeout(8000),
      catchError((err) => {
        console.error('[AdminDashboard] bookings error:', err);
        this.errorMsg ||= 'Some dashboard data failed to load.';
        return of([] as any[]);
      })
    );

    const users$ = this.http.get<any[]>(`${this.API}/users`, this.headers).pipe(
      timeout(8000),
      catchError((err) => {
        console.error('[AdminDashboard] users error:', err);
        this.errorMsg ||= 'Some dashboard data failed to load.';
        return of([] as any[]);
      })
    );

    forkJoin({ events: events$, bookings: bookings$, users: users$ })
      .pipe(finalize(() => (this.loading = false)))
      .subscribe((res) => {
        this.events = Array.isArray(res.events) ? res.events : [];
        this.bookings = Array.isArray(res.bookings) ? res.bookings : [];
        this.users = Array.isArray(res.users) ? res.users : [];

        console.log('[AdminDashboard] loaded:', {
          events: this.events.length,
          bookings: this.bookings.length,
          users: this.users.length
        });
      });
  }

  // ✅ helper to safely get event id
  private getEventId(e: any): string {
    return String(e?._id || e?.id || '');
  }

  // EVENTS
  deleteEvent(e: any) {
    const id = this.getEventId(e);
    if (!id) return;

    if (!confirm('Delete this event?')) return;

    this.http.delete(`${this.API}/events/${id}`, this.headers).subscribe({
      next: () => this.loadAll(),
      error: (err) => console.error('deleteEvent error', err)
    });
  }

  editEvent(e: any) {
    const id = this.getEventId(e);
    if (!id) return;

    this.router.navigate(['/create-event'], { queryParams: { id } });
  }

  // BOOKINGS
  deleteBooking(id: string) {
    if (!confirm('Delete booking?')) return;
    this.http.delete(`${this.API}/bookings/${id}`, this.headers).subscribe({
      next: () => this.loadAll(),
      error: (err) => console.error('deleteBooking error', err)
    });
  }

  // STATS
  get totalEvents() { return this.events.length; }
  get totalBookings() { return this.bookings.length; }
  get totalUsers() { return this.users.length; }

  remainingSeats(e: any): number {
    if (!e) return 0;
    if (typeof e.remainingSeats === 'number') return e.remainingSeats;
    if (typeof e.seatsLeft === 'number') return e.seatsLeft;
    if (typeof e.availableSeats === 'number') return e.availableSeats;

    const total = Number(e.totalSeats ?? e.seats ?? 0);
    const booked = Number(e.bookedSeats ?? 0);
    const left = total - booked;
    return isNaN(left) ? 0 : Math.max(0, left);
  }

  statusOfEvent(e: any): EventStatus {
    const left = this.remainingSeats(e);
    const d = new Date(e?.date);
    const now = new Date();

    if (left <= 0) return 'Sold Out';
    if (!isNaN(d.getTime()) && d.getTime() < now.getTime()) return 'Past';
    return 'Upcoming';
  }

  get upcomingCount() {
    return this.events.filter(e => this.statusOfEvent(e) === 'Upcoming').length;
  }

  get soldOutCount() {
    return this.events.filter(e => this.statusOfEvent(e) === 'Sold Out').length;
  }

  get lowSeatsCount(): number {
    return this.events.filter((e) => {
      const left = this.remainingSeats(e);
      return left > 0 && left <= 10;
    }).length;
  }

  get filteredEvents() {
    const text = this.searchText.trim().toLowerCase();
    return this.events.filter((e) => {
      const title = (e?.title || '').toLowerCase();
      const venue = (e?.venue || '').toLowerCase();
      const status = this.statusOfEvent(e);

      const matchesText = !text || title.includes(text) || venue.includes(text);

      const matchesFilter =
        this.statusFilter === 'all' ||
        (this.statusFilter === 'upcoming' && status === 'Upcoming') ||
        (this.statusFilter === 'past' && status === 'Past') ||
        (this.statusFilter === 'soldout' && status === 'Sold Out');

      return matchesText && matchesFilter;
    });
  }

  get recentBookings() {
    const copy = [...this.bookings];
    copy.sort((a, b) => {
      const da = new Date(a?.createdAt || a?.date || 0).getTime();
      const db = new Date(b?.createdAt || b?.date || 0).getTime();
      return db - da;
    });
    return copy.slice(0, 8);
  }

  logout() {
    this.auth.logout();
  }
}
