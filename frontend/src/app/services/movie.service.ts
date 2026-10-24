import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { shareReplay } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import {
  MovieDetailResponse,
  MovieListResponse,
  MovieRecommendationResponse,
  MovieSearchResponse,
} from '../models/movie.model';

@Injectable({
  providedIn: 'root',
})
export class MovieService {
  private http = inject(HttpClient);
  private api = `${environment.apiUrl}/api/movies`;
  private searchCache = new Map<string, Observable<MovieSearchResponse>>();
  private recommendationCache = new Map<string, Observable<MovieRecommendationResponse>>();
  private movieListCache = new Map<string, Observable<MovieListResponse>>();
  private movieByIdCache = new Map<string, Observable<MovieDetailResponse>>();

  getMovies(query = '', page = 1, limit = 12): Observable<MovieListResponse> {
    const key = JSON.stringify(['list', query.trim().toLowerCase(), page, limit]);
    const cached = this.movieListCache.get(key);
    if (cached) return cached;

    let params = new HttpParams()
      .set('page', String(Math.max(1, page)))
      .set('limit', String(Math.max(1, limit)));

    if (query.trim()) {
      params = params.set('q', query.trim());
    }

    // No OMDB enrichment here — use only the posterUrl stored in the DB.
    // Calling OMDB for every movie in the list caused excessive network requests.
    const request$ = this.http.get<MovieListResponse>(this.api, { params }).pipe(
      shareReplay(1)
    );

    this.movieListCache.set(key, request$);
    return request$;
  }

  searchMovies(query: string, limit = 8): Observable<MovieSearchResponse> {
    const normalizedQuery = query.trim().toLowerCase();
    const key = JSON.stringify(['search', normalizedQuery, limit]);
    const cached = this.searchCache.get(key);
    if (cached) return cached;

    const params = new HttpParams()
      .set('q', query.trim())
      .set('limit', String(limit));

    // No OMDB enrichment — use only posterUrl from the DB.
    const request$ = this.http.get<MovieSearchResponse>(`${this.api}/search`, { params }).pipe(
      shareReplay(1)
    );

    this.searchCache.set(key, request$);
    return request$;
  }

  getRecommendations(title: string, limit = 6): Observable<MovieRecommendationResponse> {
    const normalizedTitle = title.trim().toLowerCase();
    const key = JSON.stringify(['recommend', normalizedTitle, limit]);
    const cached = this.recommendationCache.get(key);
    if (cached) return cached;

    const params = new HttpParams()
      .set('title', title.trim())
      .set('limit', String(limit));

    // No OMDB enrichment — each recommended movie uses the posterUrl stored in the DB.
    // Previously this fired one OMDB call per recommendation (up to 8 at once).
    const request$ = this.http.get<MovieRecommendationResponse>(`${this.api}/recommendations`, { params }).pipe(
      shareReplay(1)
    );

    this.recommendationCache.set(key, request$);
    return request$;
  }

  getMovieById(movieId: string): Observable<MovieDetailResponse> {
    const normalizedId = movieId.trim();
    const cached = this.movieByIdCache.get(normalizedId);
    if (cached) return cached;

    // No OMDB enrichment — use only the data stored in the DB.
    const request$ = this.http
      .get<MovieDetailResponse>(`${this.api}/${encodeURIComponent(movieId.trim())}`)
      .pipe(shareReplay(1));

    this.movieByIdCache.set(normalizedId, request$);
    return request$;
  }
}
