// services/event.service.ts
// All poster/image enrichment now happens on the backend (via TMDB with server-side caching).
// The frontend never calls OMDB or TMDB directly — API keys stay on the server.

import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { Event } from '../models/event.model';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root',
})
export class EventService {
  private API = `${environment.apiUrl}/api/events`;

  // Session-level cache for categories (rarely changes during a session)
  private categoriesCache: string[] | null = null;

  constructor(private http: HttpClient) {}

  private getAuthHeadersJson() {
    const token = localStorage.getItem('token');
    return {
      headers: new HttpHeaders({
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }),
    };
  }

  private getAuthHeadersFormData() {
    const token = localStorage.getItem('token');
    return {
      headers: new HttpHeaders({
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }),
    };
  }

  private unwrap(res: any): any {
    return res?.event ?? res?.data ?? res;
  }

  private normalizeImageUrl(url: any): string {
    if (!url || typeof url !== 'string') return '';

    const base = environment.apiUrl.replace(/\/+$/, '');

    url = url
      .replace(/^http:\/\/localhost:5000/i, base)
      .replace(/^https?:\/\/localhost:5000/i, base);

    if (url.startsWith('/')) return `${base}${url}`;
    if (/^https?:\/\//i.test(url)) return url;

    return url;
  }

  private normalizeEvent(e: any): Event {
    const ev = this.unwrap(e);
    const id = ev?.id || ev?._id;

    return {
      ...ev,
      id,
      bookedSeats: ev?.bookedSeats ?? 0,
      imageUrl: this.normalizeImageUrl(ev?.imageUrl),
    } as Event;
  }

  getAllEvents(
    category?: string,
    page?: number,
    limit?: number,
    query?: string,
    sourceMovieId?: string
  ): Observable<{
    data: Event[];
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }> {
    let params = new HttpParams();
    if (category) params = params.set('category', category);
    if (page) params = params.set('page', String(page));
    if (limit) params = params.set('limit', String(limit));
    if (query?.trim()) params = params.set('q', query.trim());
    if (sourceMovieId?.trim()) params = params.set('sourceMovieId', sourceMovieId.trim());

    return this.http.get<any>(this.API, { params }).pipe(
      map((res) => {
        const list = Array.isArray(res)
          ? res
          : Array.isArray(res?.events)
            ? res.events
            : Array.isArray(res?.data)
              ? res.data
              : [];

        const data = list.map((e: any) => this.normalizeEvent(e));

        if (Array.isArray(res)) {
          return { data, page: 1, limit: data.length, total: data.length, totalPages: 1 };
        }

        return {
          data,
          page: Number(res?.page) || 1,
          limit: Number(res?.limit) || data.length,
          total: Number(res?.total) || data.length,
          totalPages: Number(res?.totalPages) || 1,
        };
      })
      // NOTE: No OMDB/TMDB enrichment on the list — backend enriches only getEventById.
      // This keeps the events list fast (1 request, no external calls).
    );
  }

  getMovieEvent(sourceMovieId: string): Observable<Event | null> {
    const normalizedId = String(sourceMovieId || '').trim();
    if (!normalizedId) return of(null);

    return this.http
      .get<any>(`${this.API}/movie-source/${encodeURIComponent(normalizedId)}`)
      .pipe(
        map((res) => this.normalizeEvent(res)),
        // No OMDB — if the event has an imageUrl from the backend, it's used; otherwise no image.
      );
  }

  getEventById(id: string): Observable<Event> {
    // The backend now enriches the event with a TMDB poster (cached 24h server-side)
    // before responding, so no external API calls are needed here.
    return this.http
      .get<any>(`${this.API}/${id}`)
      .pipe(map((res) => this.normalizeEvent(res)));
  }

  createEvent(event: Event | FormData): Observable<Event> {
    const isFormData = event instanceof FormData;
    const options = isFormData ? this.getAuthHeadersFormData() : this.getAuthHeadersJson();
    return this.http
      .post<any>(this.API, event as any, options)
      .pipe(map((res) => this.normalizeEvent(res)));
  }

  updateEvent(id: string, event: Event | FormData): Observable<Event> {
    const isFormData = event instanceof FormData;
    const options = isFormData ? this.getAuthHeadersFormData() : this.getAuthHeadersJson();
    return this.http
      .put<any>(`${this.API}/${id}`, event as any, options)
      .pipe(map((res) => this.normalizeEvent(res)));
  }

  deleteEvent(id: string): Observable<any> {
    return this.http.delete(`${this.API}/${id}`, this.getAuthHeadersJson());
  }

  bookSeats(id: string, seats: number): Observable<any> {
    return this.http.post(`${this.API}/${id}/book`, { seats }, this.getAuthHeadersJson());
  }

  getCategories(): Observable<string[]> {
    // Return cached result — categories rarely change during a session
    if (this.categoriesCache !== null) {
      return of(this.categoriesCache);
    }

    return this.http.get<any>(`${this.API}/categories`).pipe(
      map((res) => {
        const list = Array.isArray(res) ? res : res?.categories;
        return Array.isArray(list) ? list : [];
      }),
      map((list) => {
        this.categoriesCache = list;
        return list;
      })
    );
  }

  getEventImageUrl(e: any): string {
    const base = environment.apiUrl.replace(/\/+$/, '');
    const id = e?.id || e?._id;

    // 1. Direct imageUrl (may be a TMDB URL, a relative path, or a full URL already set by backend)
    if (e?.imageUrl) return this.normalizeImageUrl(e.imageUrl);

    // 2. GridFS image served via the backend API
    if (e?.imageFileId) {
      return id ? `${base}/api/events/${id}/image` : '';
    }

    // 3. TMDB poster stored in movieMeta (set by backend enrichment)
    if (e?.movieMeta?.posterUrl) return this.normalizeImageUrl(e.movieMeta.posterUrl);

    return '';
  }
}
