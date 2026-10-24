import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Params, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { combineLatest } from 'rxjs';
import { CatalogFacets, EventService, ExploreQuery } from '../../services/event.service';
import { CityService } from '../../services/city.service';
import { ChatService } from '../../components/chat/services/chat.service';
import { PosterCardComponent } from '../../shared/poster-card/poster-card.component';
import { Event } from '../../models/event.model';

type DateKey = 'today' | 'tomorrow' | 'weekend';
type PriceKey = 'free' | 'under-500' | '500-2000' | 'above-2000';
type SortKey = NonNullable<ExploreQuery['sort']>;

const PAGE_SIZE = 20;

export const DATE_OPTIONS: { key: DateKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'weekend', label: 'This Weekend' },
];

export const PRICE_OPTIONS: { key: PriceKey; label: string; min?: number; max?: number }[] = [
  { key: 'free', label: 'Free', max: 0 },
  { key: 'under-500', label: '₹0 – ₹500', max: 500 },
  { key: '500-2000', label: '₹501 – ₹2000', min: 501, max: 2000 },
  { key: 'above-2000', label: 'Above ₹2000', min: 2001 },
];

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'popular', label: 'Popularity' },
  { key: 'date', label: 'Date' },
  { key: 'priceAsc', label: 'Price: Low to High' },
  { key: 'priceDesc', label: 'Price: High to Low' },
];

/** Friendly names for category chips and headings (BookMyShow wording). */
const CATEGORY_LABELS: Record<string, string> = {
  Comedy: 'Comedy Shows',
  Concert: 'Music Shows',
  Sports: 'Sports',
  Workshop: 'Workshops',
  Seminar: 'Talks & Seminars',
  Plays: 'Theatre & Plays',
  Activities: 'Activities',
  Movie: 'Movies',
};

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** [from, to] for a date shortcut, in the viewer's local calendar. */
export function dateRange(key: DateKey, now = new Date()): [string, string] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (key === 'today') return [isoDate(today), isoDate(today)];
  if (key === 'tomorrow') {
    const t = new Date(today.getTime() + 86400000);
    return [isoDate(t), isoDate(t)];
  }
  const dow = today.getDay(); // 0 = Sunday
  const sat = dow === 0 ? today : new Date(today.getTime() + ((6 - dow) % 7) * 86400000);
  const sun = dow === 0 ? today : new Date(sat.getTime() + 86400000);
  return [isoDate(sat), isoDate(sun)];
}

/**
 * BookMyShow-style "Explore events" listing. Everything — search text, categories, dates, price,
 * sort, and whether the results came from the AI chat — lives in the URL, so the chat assistant
 * and the header search can open any result set with a plain router navigation.
 */
@Component({
  standalone: true,
  selector: 'app-explore',
  imports: [CommonModule, RouterLink, PosterCardComponent],
  templateUrl: './explore.component.html',
  styleUrls: ['./explore.component.css'],
})
export class ExploreComponent implements OnInit {
  private es = inject(EventService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  readonly cityService = inject(CityService);
  readonly chat = inject(ChatService);

  readonly dateOptions = DATE_OPTIONS;
  readonly priceOptions = PRICE_OPTIONS;
  readonly sortOptions = SORT_OPTIONS;

  readonly params = signal<Params>({});
  readonly city = signal(this.cityService.currentCity);
  readonly events = signal<Event[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly loadingMore = signal(false);
  readonly error = signal('');
  readonly facets = signal<CatalogFacets | null>(null);
  readonly filtersOpen = signal(false);
  private page = 1;
  private requestId = 0;

  readonly q = computed(() => String(this.params()['q'] || '').trim());
  readonly selectedCategories = computed(() =>
    String(this.params()['category'] || '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
  );
  readonly dateKey = computed(() => (this.params()['date'] as DateKey) || null);
  readonly priceKey = computed(() => (this.params()['price'] as PriceKey) || null);
  readonly sort = computed<SortKey>(() => (this.params()['sort'] as SortKey) || (this.q() ? 'relevance' : 'popular'));
  readonly fromChat = computed(() => this.params()['src'] === 'chat');
  readonly chatQuery = computed(() => String(this.params()['ai'] || '').trim());
  /** Movies are listed only for text searches, the Movie category, or an explicit live=false. */
  readonly includesMovies = computed(() => {
    const live = this.params()['live'];
    if (live === 'true') return false;
    return !!this.q() || this.selectedCategories().some((c) => /^movies?$/i.test(c)) || live === 'false';
  });

  /** Category chips: live categories that have upcoming events, most populated first. */
  readonly categoryChips = computed(() => {
    const counts = this.facets()?.categoryCounts || {};
    return Object.keys(counts)
      .filter((c) => !/^movies?$/i.test(c))
      .sort((a, b) => counts[b] - counts[a])
      .map((c) => ({ key: c, label: CATEGORY_LABELS[c] || c }));
  });

  readonly heading = computed(() => {
    const city = this.city();
    if (this.q()) return `Results for “${this.q()}”`;
    const cats = this.selectedCategories();
    if (cats.length === 1) return `${CATEGORY_LABELS[cats[0]] || cats[0]} in ${city}`;
    return `Events in ${city}`;
  });

  readonly activeFilterCount = computed(
    () => this.selectedCategories().length + (this.dateKey() ? 1 : 0) + (this.priceKey() ? 1 : 0) + (this.params()['genre'] ? 1 : 0)
  );

  readonly hasMore = computed(() => this.events().length < this.total());

  ngOnInit(): void {
    this.es
      .getFacets()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (f) => this.facets.set(f), error: () => this.facets.set(null) });

    combineLatest([this.route.queryParams, this.cityService.selectedCity$])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(([params, city]) => {
        // A city named in the URL (e.g. by the chat assistant) becomes the selected city.
        const urlCity = String(params['city'] || '').trim();
        const known = this.cityService.popularCities.find((c) => c.toLowerCase() === urlCity.toLowerCase());
        if (known && known !== city) {
          this.cityService.setCity(known);
          return; // selectedCity$ emits again with the new city
        }
        this.params.set(params);
        this.city.set(city);
        this.load(Math.max(1, Number(params['p']) || 1));
      });
  }

  private query(): ExploreQuery {
    const p = this.params();
    const q: ExploreQuery = {
      q: this.q() || undefined,
      category: this.selectedCategories().join(',') || undefined,
      city: this.city(),
      genre: p['genre'] || undefined,
      venue: p['venue'] || undefined,
      sort: this.sort(),
      upcoming: p['past'] === 'true' ? undefined : 'true',
      live: this.includesMovies() ? undefined : 'true',
    };
    const dk = this.dateKey();
    if (dk && DATE_OPTIONS.some((d) => d.key === dk)) {
      [q.from, q.to] = dateRange(dk);
    } else {
      q.from = p['from'] || undefined;
      q.to = p['to'] || undefined;
    }
    const price = PRICE_OPTIONS.find((o) => o.key === this.priceKey());
    if (price) {
      q.minPrice = price.min;
      q.maxPrice = price.max;
    } else {
      if (p['minPrice']) q.minPrice = Number(p['minPrice']);
      if (p['maxPrice']) q.maxPrice = Number(p['maxPrice']);
    }
    return q;
  }

  /** Loads pages 1..pages (the chat's "show me more" asks for one more page than before). */
  private load(pages: number): void {
    const id = ++this.requestId;
    this.loading.set(true);
    this.error.set('');
    this.es.explore(this.query(), 1, PAGE_SIZE * pages).subscribe({
      next: (res) => {
        if (id !== this.requestId) return;
        this.events.set(res.data);
        this.total.set(res.total);
        this.page = pages;
        this.loading.set(false);
        if (pages > 1) setTimeout(() => this.scrollToPage(pages), 50);
      },
      error: (err) => {
        if (id !== this.requestId) return;
        this.loading.set(false);
        this.events.set([]);
        this.total.set(0);
        this.error.set(err?.error?.message || 'Events could not be loaded. Please try again.');
      },
    });
  }

  loadMore(): void {
    if (this.loadingMore() || !this.hasMore()) return;
    const id = this.requestId;
    this.loadingMore.set(true);
    this.es.explore(this.query(), this.page + 1, PAGE_SIZE).subscribe({
      next: (res) => {
        this.loadingMore.set(false);
        if (id !== this.requestId) return;
        this.page += 1;
        this.events.update((list) => [...list, ...res.data]);
        this.total.set(res.total);
      },
      error: () => this.loadingMore.set(false),
    });
  }

  private scrollToPage(pages: number): void {
    const cards = document.querySelectorAll('.results-grid app-poster-card');
    const first = cards[(pages - 1) * PAGE_SIZE] as HTMLElement | undefined;
    first?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Filter changes (URL is the single source of truth) ───────────────────────

  private update(changes: Params): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { ...changes, p: null },
      queryParamsHandling: 'merge',
    });
  }

  toggleCategory(cat: string): void {
    const current = this.selectedCategories();
    const next = current.includes(cat) ? current.filter((c) => c !== cat) : [...current, cat];
    this.update({ category: next.join(',') || null });
  }

  isCategorySelected(cat: string): boolean {
    return this.selectedCategories().includes(cat);
  }

  setDate(key: DateKey): void {
    this.update({ date: this.dateKey() === key ? null : key, from: null, to: null });
  }

  setPrice(key: PriceKey): void {
    this.update({ price: this.priceKey() === key ? null : key, minPrice: null, maxPrice: null });
  }

  setSort(key: string): void {
    this.update({ sort: key });
  }

  clearSection(section: 'date' | 'category' | 'price'): void {
    if (section === 'date') this.update({ date: null, from: null, to: null });
    if (section === 'category') this.update({ category: null, genre: null });
    if (section === 'price') this.update({ price: null, minPrice: null, maxPrice: null });
  }

  clearAll(): void {
    this.router.navigate([], { relativeTo: this.route, queryParams: {} });
  }

  clearChatResults(): void {
    this.update({ src: null, ai: null });
  }

  refineInChat(): void {
    this.chat.open();
  }

  categoryLabel(cat: string): string {
    return CATEGORY_LABELS[cat] || cat;
  }

  categoryCount(cat: string): number {
    return this.facets()?.categoryCounts?.[cat] ?? 0;
  }

  trackEvent(_: number, e: Event): string {
    return String(e.id || e._id);
  }
}
