import { Component, OnDestroy, OnInit, inject, ElementRef, ViewChild, effect } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { RouterModule, Router, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { EventService } from '../../services/event.service';
import { Subject, takeUntil, forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { HeroCarouselComponent } from '../../shared/hero-carousel/hero-carousel.component';
import { MovieService } from '../../services/movie.service';
import { MovieRecommendationItem } from '../../models/movie.model';
import { BookingAssistantService } from '../../services/booking-assistant.service';

/** Row titles for the home page, keyed by event category. */
const ROW_COPY: Record<string, { title: string; subtitle: string }> = {
  comedy: { title: 'Comedy Nights', subtitle: 'Stand-up and comedy shows' },
  concert: { title: 'Live Music', subtitle: 'Concerts and gigs' },
  plays: { title: 'Theatre', subtitle: 'Plays and stage shows' },
  sports: { title: 'Sports', subtitle: 'Matches and tournaments' },
  workshop: { title: 'Learn Something New', subtitle: 'Workshops and classes' },
  activities: { title: 'Weekend Plans', subtitle: 'Activities and experiences' },
  seminar: { title: 'Talks & Seminars', subtitle: 'Learn from experts' },
};

export interface HomeRow {
  key: string;
  title: string;
  subtitle: string;
  category: string | null;
  items: any[];
}

@Component({
  standalone: true,
  selector: 'app-events',
  imports: [CommonModule, RouterModule, FormsModule, DatePipe, HeroCarouselComponent],
  templateUrl: './events.component.html',
  styleUrls: ['./events.component.css'],
})
export class EventsComponent implements OnInit, OnDestroy {
  private es = inject(EventService);
  private movieService = inject(MovieService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  assistantService = inject(BookingAssistantService);
  private destroy$ = new Subject<void>();
  private searchInput$ = new Subject<string>();

  constructor() {
    effect(() => {
      const activeQ = this.assistantService.activeSearchQuery();
      const trimmed = (activeQ || '').trim();
      if (trimmed && trimmed.toLowerCase() !== this.q.trim().toLowerCase()) {
        this.q = trimmed;
        this.router.navigate([], {
          relativeTo: this.route,
          queryParams: { q: trimmed },
          queryParamsHandling: 'merge',
        });
        this.executeSearch(trimmed);
      }
    });
  }
  private movieSearchToken = 0;
  private matchedEventsToken = 0;

  // Home/all view should show event cards (not the movie catalog grid)
  showMovieCatalog = false;

  loading = false;
  loadingMore = false;
  error = '';
  events: any[] = [];
  categories: string[] = [];
  private page = 1;
  private readonly pageSize = 12;
  hasMore = true;
  private activeCategoryParam = '';
  private observer?: IntersectionObserver;
  private movieObserver?: IntersectionObserver;
  private moviePage = 1;
  private readonly moviePageSize = 12;
  movieHasMore = true;
  movieListLoading = false;
  movieListLoadingMore = false;
  movieListError = '';
  movies: MovieRecommendationItem[] = [];

  @ViewChild('sentinel') set sentinelRef(el: ElementRef<HTMLDivElement> | undefined) {
    if (!el) return;
    this.setupObserver(el.nativeElement);
  }

  @ViewChild('movieSentinel') set movieSentinelRef(el: ElementRef<HTMLDivElement> | undefined) {
    if (!el) return;
    this.setupMovieObserver(el.nativeElement);
  }

  // UI state
  q = '';
  status: 'all' | 'upcoming' | 'past' | 'soldout' = 'all';
  sort: 'dateAsc' | 'dateDesc' | 'priceAsc' | 'priceDesc' = 'dateAsc';
  categoryFilter = 'all';
  movieSearchActive = false;
  selectedMovie: MovieRecommendationItem | null = null;
  movieRecommendations: MovieRecommendationItem[] = [];
  foundMovies: MovieRecommendationItem[] = [];
  searchLoading = false;
  recommendationLoading = false;
  recommendationError = '';
  closestMatchNote = '';
  matchedEventsLoading = false;
  matchedEventsError = '';
  matchedEvents: any[] = [];
  searchError = '';
  quickMatches: MovieRecommendationItem[] = [];

  private imgErrorIds = new Set<string>();

  recommendedMovies: MovieRecommendationItem[] = [];
  premiereMovies: MovieRecommendationItem[] = [];
  topMovies: MovieRecommendationItem[] = [];
  moviesLoading = false;

  // Home page: billboard of upcoming events and Netflix-style rows per category.
  billboard: any[] = [];
  billboardIndex = 0;
  private billboardTimer: ReturnType<typeof setInterval> | null = null;
  homeRows: HomeRow[] = [];
  homeRowsLoading = false;

  ngOnInit(): void {
    this.loadCategories();
    this.loadHomeMovieCarousels();
    this.loadHomeRows();
    if (this.showMovieCatalog) this.loadMovies(true);

    this.route.queryParamMap.pipe(takeUntil(this.destroy$)).subscribe((params) => {
      const catParam = params.get('category');
      const cat = catParam ? catParam.trim() : 'all';
      this.categoryFilter = cat;
      this.activeCategoryParam = cat.toLowerCase() === 'all' ? '' : cat;

      const qParam = (params.get('q') || '').trim();
      if (qParam) {
        this.q = qParam;
        this.executeSearch(qParam);
      } else {
        this.clearMovieSearchState();
        this.fetchEvents(this.activeCategoryParam, true);
      }
    });

    this.searchInput$
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe((query) => {
        this.onSearchChange(query);
      });
  }

  loadHomeMovieCarousels(): void {
    this.moviesLoading = true;
    this.movieService.getMovies('', 1, 14).subscribe({
      next: (res) => {
        const all = Array.isArray(res?.data) ? res.data : [];
        this.recommendedMovies = all.slice(0, 8);
        this.premiereMovies = all.slice(4, 12);
        this.topMovies = [...all].sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 10);
        this.moviesLoading = false;
      },
      error: () => {
        this.moviesLoading = false;
      }
    });
  }

  /** One row per category with upcoming events; thin categories are merged into a mixed row. */
  loadHomeRows(): void {
    this.homeRowsLoading = true;
    this.es.getCategories().subscribe({
      next: (list: string[]) => {
        const categories = (Array.isArray(list) ? list : []).filter((c) => c.toLowerCase() !== 'movie');
        if (!categories.length) {
          this.homeRowsLoading = false;
          return;
        }
        forkJoin(
          categories.map((c) => this.es.getUpcomingEvents(c, 20).pipe(catchError(() => of([]))))
        ).subscribe((results) => {
          const rows: HomeRow[] = [];
          const mixed: any[] = [];
          categories.forEach((category, i) => {
            const items = results[i] || [];
            if (items.length >= 3) {
              const copy = ROW_COPY[category.toLowerCase()] || { title: category, subtitle: '' };
              rows.push({ key: category, category, items, ...copy });
            } else {
              mixed.push(...items);
            }
          });
          if (mixed.length) {
            rows.push({ key: 'mixed', category: null, title: 'Try Something Different', subtitle: 'Workshops, plays, activities and more', items: mixed });
          }
          this.homeRows = rows;
          this.homeRowsLoading = false;

          // Billboard: upcoming events with artwork, ones with a description first.
          const all = results.flat().filter((e) => this.shouldShowImg(e));
          this.billboard = all
            .sort((a, b) => Number(!!this.plainText(b.description)) - Number(!!this.plainText(a.description)))
            .slice(0, 5);
          this.billboardIndex = 0;
          this.startBillboard();
        });
      },
      error: () => (this.homeRowsLoading = false),
    });
  }

  get activeBillboard(): any | null {
    return this.billboard[this.billboardIndex] || null;
  }

  showBillboard(i: number): void {
    this.billboardIndex = i;
    this.startBillboard();
  }

  private startBillboard(): void {
    if (this.billboardTimer) clearInterval(this.billboardTimer);
    if (this.billboard.length < 2) return;
    this.billboardTimer = setInterval(() => {
      this.billboardIndex = (this.billboardIndex + 1) % this.billboard.length;
    }, 7000);
  }

  /** Categories for the chips; "Movie" is covered by the separate Movies link. */
  get eventCategories(): string[] {
    return this.categories.filter((c) => c.toLowerCase() !== 'movie');
  }

  /** Seed descriptions sometimes start lowercase. */
  sentence(text: string): string {
    const t = (text || '').trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
  }

  /** Event descriptions may contain HTML from the rich editor. */
  plainText(html: string | undefined | null): string {
    if (!html) return '';
    const text = String(html).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    return text;
  }

  /** "Sat, 14 Nov" for a future date; multi-show events whose first date passed are still running. */
  whenLabel(e: any): string {
    const d = new Date(e?.date);
    if (isNaN(d.getTime())) return '';
    if (d.getTime() < Date.now()) return 'Shows running now';
    return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  scrollRow(elementId: string, distance: number): void {
    const el = document.getElementById(elementId);
    if (el) {
      el.scrollBy({ left: distance, behavior: 'smooth' });
    }
  }

  loadCategories(): void {
    this.es.getCategories().subscribe({
      next: (list: string[]) => {
        this.categories = Array.isArray(list) ? list : [];
      },
      error: () => {
        this.categories = [];
      }
    });
  }

  selectCategory(value: string) {
    const norm = (value || 'all').trim();
    this.categoryFilter = norm;
    const categoryParam = norm.toLowerCase() === 'all' ? '' : norm;
    this.activeCategoryParam = categoryParam;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        category: categoryParam || null,
        q: null,
      },
      queryParamsHandling: '',
    });
  }
  fetchEvents(category?: string, reset = false): void {
    if (!reset && (!this.hasMore || this.loadingMore)) return;

    if (reset) {
      this.page = 1;
      this.hasMore = true;
      this.events = [];
    }

    if (reset) {
      this.loading = true;
    } else {
      this.loadingMore = true;
    }
    this.error = '';

    this.es.getAllEvents(category, this.page, this.pageSize).subscribe({
      next: (res: any) => {
        const list = Array.isArray(res?.data) ? res.data : [];
        this.events = reset ? list : [...this.events, ...list];
        const totalPages = Number(res?.totalPages) || 1;
        const currentPage = Number(res?.page) || this.page;
        this.hasMore = currentPage < totalPages && list.length > 0;
        this.page = currentPage + 1;
        if (reset) this.imgErrorIds.clear();
      },
      error: (err: any) => {
        this.error = err?.error?.message || 'Failed to load events.';
      },
      complete: () => {
        this.loading = false;
        this.loadingMore = false;
      },
    });
  }

  private eventIdOf(e: any): string {
    return String(e?._id || e?.id || '');
  }

  imgUrl(e: any): string {
    return this.es.getEventImageUrl(e);
  }

  onImgError(e: any): void {
    const id = this.eventIdOf(e);
    if (!id) return;
    this.imgErrorIds.add(id);
  }

  shouldShowImg(e: any): boolean {
    const id = this.eventIdOf(e);
    if (!id) return false;
    return !!this.imgUrl(e) && !this.imgErrorIds.has(id);
  }


  remainingSeats(e: any): number {
    const total = Number(e?.totalSeats ?? 0);
    const booked = Number(e?.bookedSeats ?? 0);
    const left = total - booked;
    return isNaN(left) ? 0 : Math.max(0, left);
  }

  statusOf(e: any): 'Upcoming' | 'Past' | 'Sold Out' {
    const left = this.remainingSeats(e);
    if (left <= 0) return 'Sold Out';
    const d = new Date(e?.date);
    if (!isNaN(d.getTime()) && d.getTime() < Date.now()) return 'Past';
    return 'Upcoming';
  }

  get filtered(): any[] {
    const text = this.q.trim().toLowerCase();

    let list = this.events.filter((e) => {
      const title = (e?.title || '').toLowerCase();
      const venue = (e?.venue || '').toLowerCase();
      const matchesText = !text || title.includes(text) || venue.includes(text);

      const st = this.statusOf(e);
      const matchesStatus =
        this.status === 'all' ||
        (this.status === 'upcoming' && st === 'Upcoming') ||
        (this.status === 'past' && st === 'Past') ||
        (this.status === 'soldout' && st === 'Sold Out');

      const matchesCategory = this.matchesCategory(e);

      return matchesText && matchesStatus && matchesCategory;
    });

    list = list.sort((a, b) => {
      const da = new Date(a?.date || 0).getTime();
      const db = new Date(b?.date || 0).getTime();
      const pa = Number(a?.price ?? 0);
      const pb = Number(b?.price ?? 0);

      switch (this.sort) {
        case 'dateAsc': return da - db;
        case 'dateDesc': return db - da;
        case 'priceAsc': return pa - pb;
        case 'priceDesc': return pb - pa;
        default: return 0;
      }
    });

    return list;
  }

  private matchesCategory(e: any): boolean {
    if (!this.categoryFilter || this.categoryFilter.toLowerCase() === 'all') return true;
    const category = String(e?.category || '').toLowerCase().trim();
    const target = String(this.categoryFilter || '').toLowerCase().trim();
    if (category === target) return true;
    if (target === 'plays' && (category.includes('theatre') || category.includes('theater') || category.includes('play'))) return true;
    if (target === 'concerts' && (category.includes('music') || category.includes('concert'))) return true;
    if (target === 'activities' && (category.includes('misc') || category.includes('activit'))) return true;
    return category.includes(target) || target.includes(category);
  }

  openEvent(e: any): void {
    const id = e?._id || e?.id;
    if (!id) return;
    this.assistantService.selectItem(e);
    this.router.navigate(['/events', id]);
  }

  onSearchChange(value: string): void {
    const trimmed = (value || '').trim();
    this.assistantService.setSearchQuery(trimmed);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { q: trimmed ? trimmed : null },
      queryParamsHandling: 'merge',
    });
  }

  openMovie(movie: MovieRecommendationItem): void {
    if (!movie.movieId) return;
    this.assistantService.selectItem(movie);
    this.es.getMovieEvent(movie.movieId).subscribe({
      next: (event) => {
        const eventId = event?._id || event?.id;
        if (eventId) {
          this.router.navigate(['/events', eventId]);
          return;
        }
        this.router.navigate(['/movies', movie.movieId]);
      },
      error: () => {
        this.router.navigate(['/movies', movie.movieId]);
      },
    });
  }

  eventCardClass(e: any): string {
    const t = String(e?.designTemplate || '').toLowerCase();
    if (t === 'movie') return 'card-variant-movie';
    if (t === 'concert') return 'card-variant-concert';
    if (t === 'comedy') return 'card-variant-comedy';
    if (t === 'bold-split') return 'card-variant-bold';
    if (t === 'editorial') return 'card-variant-editorial';
    if (t === 'clean-hero') return 'card-variant-clean';
    return 'card-variant-clean';
  }

  private setupObserver(target: HTMLDivElement) {
    if (this.observer) this.observer.disconnect();

    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          this.fetchEvents(this.activeCategoryParam, false);
        }
      },
      { rootMargin: '200px 0px', threshold: 0.1 }
    );

    this.observer.observe(target);
  }

  private setupMovieObserver(target: HTMLDivElement) {
    if (this.movieObserver) this.movieObserver.disconnect();

    this.movieObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !this.movieSearchActive) {
          this.loadMovies(false);
        }
      },
      { rootMargin: '240px 0px', threshold: 0.1 }
    );

    this.movieObserver.observe(target);
  }

  ngOnDestroy(): void {
    if (this.observer) this.observer.disconnect();
    if (this.movieObserver) this.movieObserver.disconnect();
    if (this.billboardTimer) clearInterval(this.billboardTimer);
    this.destroy$.next();
    this.destroy$.complete();
  }

  trackMovie(_: number, movie: MovieRecommendationItem): string {
    return movie.movieId || movie.title;
  }

  moviePosterStyle(movie: MovieRecommendationItem): Record<string, string> {
    return movie.posterUrl ? { 'background-image': `url('${movie.posterUrl}')` } : {};
  }

  executeSearch(query: string): void {
    const normalized = query.trim();
    if (!normalized) {
      this.clearMovieSearchState();
      this.fetchEvents(this.activeCategoryParam, true);
      return;
    }

    const requestToken = ++this.movieSearchToken;
    this.searchLoading = true;
    this.movieSearchActive = true;
    this.searchError = '';
    this.foundMovies = [];
    this.quickMatches = [];
    this.selectedMovie = null;
    this.movieRecommendations = [];
    this.matchedEvents = [];

    let moviesDone = false;
    let eventsDone = false;
    const checkDone = () => {
      if (moviesDone && eventsDone && requestToken === this.movieSearchToken) {
        this.searchLoading = false;
      }
    };

    // 1. Search TMDB Movies
    this.movieService.searchMovies(normalized, 12).subscribe({
      next: (res) => {
        if (requestToken !== this.movieSearchToken) return;
        const results = Array.isArray(res.results) ? res.results : [];
        this.foundMovies = results;
        this.quickMatches = results;
        const selected = res.closestMatch || results[0] || null;
        this.selectedMovie = selected;

        if (selected) {
          this.movieService.getRecommendations(selected.title, 8).subscribe({
            next: (recRes) => {
              if (requestToken !== this.movieSearchToken) return;
              this.movieRecommendations = Array.isArray(recRes.recommendations)
                ? recRes.recommendations
                : [];
              moviesDone = true;
              checkDone();
            },
            error: () => {
              moviesDone = true;
              checkDone();
            }
          });
        } else {
          moviesDone = true;
          checkDone();
        }
      },
      error: () => {
        if (requestToken !== this.movieSearchToken) return;
        this.foundMovies = [];
        moviesDone = true;
        checkDone();
      }
    });

    // 2. Search Live Events (MongoDB)
    this.es.getAllEvents(undefined, 1, 24, normalized).subscribe({
      next: (res: any) => {
        if (requestToken !== this.movieSearchToken) return;
        const list = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
        this.matchedEvents = list;
        eventsDone = true;
        checkDone();
      },
      error: () => {
        if (requestToken !== this.movieSearchToken) return;
        this.matchedEvents = [];
        eventsDone = true;
        checkDone();
      }
    });
  }

  private loadMovies(reset: boolean): void {
    if (!reset && (!this.movieHasMore || this.movieListLoadingMore || this.movieSearchActive)) return;

    if (reset) {
      this.moviePage = 1;
      this.movieHasMore = true;
      this.movies = [];
      this.movieListLoading = true;
    } else {
      this.movieListLoadingMore = true;
    }

    this.movieListError = '';

    this.movieService.getMovies('', this.moviePage, this.moviePageSize).subscribe({
      next: (response) => {
        const list = Array.isArray(response.data) ? response.data : [];
        this.movies = reset ? list : [...this.movies, ...list];
        this.movieHasMore = !!response.hasMore;
        this.moviePage = (Number(response.page) || this.moviePage) + 1;
      },
      error: (error) => {
        this.movieListError = error?.error?.message || 'Movie catalog could not be loaded.';
      },
      complete: () => {
        this.movieListLoading = false;
        this.movieListLoadingMore = false;
      },
    });
  }

  clearMovieSearchState(): void {
    this.q = '';
    this.movieSearchActive = false;
    this.searchLoading = false;
    this.selectedMovie = null;
    this.foundMovies = [];
    this.movieRecommendations = [];
    this.quickMatches = [];
    this.recommendationLoading = false;
    this.recommendationError = '';
    this.closestMatchNote = '';
    this.matchedEventsLoading = false;
    this.matchedEventsError = '';
    this.matchedEvents = [];
    this.searchError = '';

    if (this.categoryFilter === 'all' && this.showMovieCatalog) {
      this.loadMovies(true);
      return;
    }

    this.movieListLoading = false;
    this.movieListLoadingMore = false;
    this.movieListError = '';
    this.movies = [];
    this.movieHasMore = false;
  }

  private loadMatchedEvents(movie: MovieRecommendationItem | null, fallbackQuery: string): void {
    const requestToken = ++this.matchedEventsToken;
    const movieId = String(movie?.movieId || '').trim();
    const title = String(movie?.title || fallbackQuery || '').trim();

    if (!movieId && !title) {
      this.matchedEventsLoading = false;
      this.matchedEventsError = '';
      this.matchedEvents = [];
      return;
    }

    this.matchedEventsLoading = true;
    this.matchedEventsError = '';

    const request$ = movieId
      ? this.es.getAllEvents(undefined, 1, 12, undefined, movieId)
      : this.es.getAllEvents(undefined, 1, 12, title);

    request$.subscribe({
      next: (response) => {
        if (requestToken !== this.matchedEventsToken) return;
        const list = Array.isArray(response?.data) ? response.data : [];
        const normalizedTitle = title.toLowerCase();
        this.matchedEvents = list.filter((event: any) => {
          const sourceMovieId = String((event as any)?.sourceMovieId || '').trim();
          if (movieId && sourceMovieId === movieId) return true;

          const eventTitle = String(event?.title || '').trim().toLowerCase();
          return normalizedTitle ? eventTitle.includes(normalizedTitle) : false;
        });
      },
      error: (error) => {
        if (requestToken !== this.matchedEventsToken) return;
        this.matchedEvents = [];
        this.matchedEventsError =
          error?.error?.message || 'Matching events could not be loaded.';
      },
      complete: () => {
        if (requestToken !== this.matchedEventsToken) return;
        this.matchedEventsLoading = false;
      },
    });
  }
}





