import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, catchError } from 'rxjs';
import { EventService, ExploreQuery } from '../../services/event.service';
import { MovieService } from '../../services/movie.service';
import { CityService } from '../../services/city.service';
import { MovieRecommendationItem } from '../../models/movie.model';
import { Event } from '../../models/event.model';
import { HeroCarouselComponent } from '../../shared/hero-carousel/hero-carousel.component';
import { PosterCardComponent } from '../../shared/poster-card/poster-card.component';

interface EventRow {
  id: string;
  title: string;
  subtitle: string;
  query: ExploreQuery;
  seeAll: Record<string, string>;
  events: Event[];
}

/** Tiles for "The Best of Live Events" (category → explore page). */
const CATEGORY_TILES = [
  { key: 'Comedy', label: 'Comedy Shows', icon: '🎤', tone: 'tone-comedy' },
  { key: 'Concert', label: 'Music Shows', icon: '🎸', tone: 'tone-music' },
  { key: 'Sports', label: 'Sports', icon: '🏏', tone: 'tone-sports' },
  { key: 'Plays', label: 'Theatre Shows', icon: '🎭', tone: 'tone-theatre' },
  { key: 'Workshop', label: 'Workshops', icon: '🎨', tone: 'tone-workshop' },
  { key: 'Activities', label: 'Activities', icon: '🧘', tone: 'tone-activity' },
  { key: 'Seminar', label: 'Talks & Seminars', icon: '💡', tone: 'tone-talks' },
];

const ROWS: Omit<EventRow, 'events'>[] = [
  { id: 'popular', title: 'Popular Events', subtitle: 'Trending in your city', query: { live: 'true', sort: 'popular' }, seeAll: {} },
  { id: 'comedy', title: 'Laughter Therapy', subtitle: 'Stand-up, open mics and more', query: { category: 'Comedy', sort: 'date' }, seeAll: { category: 'Comedy' } },
  { id: 'music', title: 'Music Shows', subtitle: 'Concerts, gigs and festivals', query: { category: 'Concert', sort: 'date' }, seeAll: { category: 'Concert' } },
  { id: 'sports', title: 'Top Games & Sport Events', subtitle: 'Cheer for your team', query: { category: 'Sports', sort: 'date' }, seeAll: { category: 'Sports' } },
  {
    id: 'more',
    title: 'Workshops, Theatre & More',
    subtitle: 'Learn something new this week',
    query: { category: 'Workshop,Plays,Activities,Seminar', sort: 'date' },
    seeAll: { category: 'Workshop,Plays,Activities,Seminar' },
  },
];

@Component({
  standalone: true,
  selector: 'app-home',
  imports: [CommonModule, RouterLink, HeroCarouselComponent, PosterCardComponent],
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.css'],
})
export class HomeComponent implements OnInit {
  private es = inject(EventService);
  private movieService = inject(MovieService);
  private cityService = inject(CityService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);

  readonly tiles = CATEGORY_TILES;
  readonly city = signal(this.cityService.currentCity);
  readonly rows = signal<EventRow[]>([]);
  readonly rowsLoading = signal(true);
  readonly movies = signal<MovieRecommendationItem[]>([]);
  readonly counts = signal<Record<string, number>>({});

  ngOnInit(): void {
    // Old links (/events?q=…, /events?category=…) now live on the explore page.
    const qp = this.route.snapshot.queryParams;
    if (qp['q'] || qp['category']) {
      this.router.navigate(['/explore'], { queryParams: qp, replaceUrl: true });
      return;
    }

    this.movieService.getMovies('', 1, 16).subscribe({
      next: (res) => this.movies.set(Array.isArray(res?.data) ? res.data : []),
      error: () => this.movies.set([]),
    });
    this.es.getFacets().subscribe({
      next: (f) => this.counts.set(f?.categoryCounts || {}),
      error: () => this.counts.set({}),
    });

    this.cityService.selectedCity$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((city) => {
      this.city.set(city);
      this.loadRows(city);
    });
  }

  private loadRows(city: string): void {
    this.rowsLoading.set(true);
    forkJoin(
      ROWS.map((row) =>
        this.es
          .explore({ ...row.query, city, upcoming: 'true' }, 1, 12)
          .pipe(catchError(() => of({ data: [] as Event[], page: 1, total: 0, totalPages: 1 })))
      )
    ).subscribe((pages) => {
      this.rows.set(ROWS.map((row, i) => ({ ...row, events: pages[i].data })).filter((r) => r.events.length));
      this.rowsLoading.set(false);
    });
  }

  tileCount(key: string): string {
    const n = this.counts()[key] || 0;
    return n ? `${n} event${n === 1 ? '' : 's'}` : 'Coming soon';
  }

  scrollRow(el: HTMLElement, direction: 1 | -1): void {
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: 'smooth' });
  }

  openMovie(movie: MovieRecommendationItem): void {
    if (!movie.movieId) return;
    this.es.getMovieEvent(movie.movieId).subscribe({
      next: (event) => {
        const id = event?._id || event?.id;
        this.router.navigate(id ? ['/events', id] : ['/movies', movie.movieId]);
      },
      error: () => this.router.navigate(['/movies', movie.movieId]),
    });
  }

  trackRow(_: number, row: EventRow): string {
    return row.id;
  }

  trackEvent(_: number, e: Event): string {
    return String(e.id || e._id);
  }

  trackMovie(_: number, m: MovieRecommendationItem): string {
    return m.movieId || m.title;
  }
}
