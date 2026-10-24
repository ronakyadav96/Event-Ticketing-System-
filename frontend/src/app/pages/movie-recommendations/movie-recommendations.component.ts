import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { MovieService } from '../../services/movie.service';
import { MovieRecommendationItem } from '../../models/movie.model';
import { EventService } from '../../services/event.service';
import { CityService } from '../../services/city.service';

@Component({
  selector: 'app-movie-recommendations',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './movie-recommendations.component.html',
  styleUrls: ['./movie-recommendations.component.css'],
})
export class MovieRecommendationsComponent implements OnInit, OnDestroy {
  private movieService = inject(MovieService);
  private eventService = inject(EventService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  cityService = inject(CityService);

  private destroy$ = new Subject<void>();
  private searchInput$ = new Subject<string>();
  private categoryLoadToken = 0;
  private recommendationLoadToken = 0;

  // Filter lists matching BookMyShow
  readonly languages = ['English', 'Hindi', 'Tamil', 'English 7D', 'Malayalam', 'Telugu', 'Korean', 'Punjabi'];
  readonly genres = ['Action', 'Comedy', 'Drama', 'Thriller', 'Adventure', 'Animation', 'Romance', 'Sci-Fi'];
  readonly formats = ['2D', '3D', 'IMAX 3D', '4DX'];

  // Collapsible Accordions
  languagesOpen = true;
  genresOpen = false;
  formatsOpen = false;

  // Active filters
  selectedLanguage = '';
  selectedGenre = '';
  selectedFormat = '';

  query = '';
  loading = false;
  searchError = '';
  closestMatchNote = '';
  selectedMovieTitle = '';
  selectedMovie: MovieRecommendationItem | null = null;
  recommendations: MovieRecommendationItem[] = [];
  quickMatches: MovieRecommendationItem[] = [];
  categoryMovies: MovieRecommendationItem[] = [];
  emptyState = '';

  ngOnInit(): void {
    this.searchInput$
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe((value) => {
        this.runAutoSearch(value);
      });

    this.route.queryParamMap.pipe(takeUntil(this.destroy$)).subscribe((params) => {
      const title = String(params.get('title') || '').trim();
      const genre = String(params.get('genre') || '').trim();
      if (genre && this.genres.includes(genre)) {
        this.selectedGenre = genre;
      }
      if (!title) {
        this.loadCategoryMovies();
        return;
      }
      if (title === this.query.trim()) return;
      this.query = title;
      this.fetchRecommendations(title);
    });

    this.loadCategoryMovies();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // Filter toggles
  toggleLanguage(lang: string): void {
    this.selectedLanguage = this.selectedLanguage === lang ? '' : lang;
  }

  clearLanguages(): void {
    this.selectedLanguage = '';
  }

  toggleGenre(genre: string): void {
    this.selectedGenre = this.selectedGenre === genre ? '' : genre;
    this.loadCategoryMovies();
  }

  clearGenres(): void {
    this.selectedGenre = '';
    this.loadCategoryMovies();
  }

  toggleFormat(fmt: string): void {
    this.selectedFormat = this.selectedFormat === fmt ? '' : fmt;
  }

  clearFormats(): void {
    this.selectedFormat = '';
  }

  browseByCinemas(): void {
    this.router.navigate(['/events'], { queryParams: { category: 'movies' } });
  }

  onQueryChange(value: string): void {
    this.query = value;
    this.searchInput$.next(value);
  }

  submitSearch(): void {
    const title = this.query.trim();
    if (!title) {
      this.resetState('');
      this.loadCategoryMovies();
      return;
    }
    this.fetchRecommendations(title);
  }

  useSuggestion(movie: MovieRecommendationItem): void {
    this.query = movie.title;
    this.submitSearch();
  }

  openMovie(movie: MovieRecommendationItem): void {
    const movieId = String(movie?.movieId || '').trim();
    if (!movieId) return;

    this.eventService.getMovieEvent(movieId).subscribe({
      next: (event) => {
        const eventId = event?._id || event?.id;
        if (eventId) {
          this.router.navigate(['/events', eventId]);
          return;
        }
        this.router.navigate(['/movies', movieId]);
      },
      error: () => {
        this.router.navigate(['/movies', movieId]);
      },
    });
  }

  private fetchRecommendations(title: string): void {
    const requestToken = ++this.recommendationLoadToken;
    this.loading = true;
    this.searchError = '';
    this.closestMatchNote = '';
    this.emptyState = '';
    this.categoryMovies = [];

    this.movieService.searchMovies(title, 8).subscribe({
      next: (searchResponse) => {
        if (requestToken !== this.recommendationLoadToken) return;
        const matches = Array.isArray(searchResponse.results) ? searchResponse.results : [];
        this.quickMatches = matches;

        const selected =
          searchResponse.closestMatch ||
          matches.find((movie) => movie.title.trim().toLowerCase() === title.trim().toLowerCase()) ||
          matches[0] ||
          null;

        if (!selected) {
          this.loading = false;
          this.selectedMovieTitle = '';
          this.selectedMovie = null;
          this.recommendations = [];
          this.searchError = 'No movie found for this search.';
          this.emptyState = 'Try a different title or pick one of the closest matches.';
          return;
        }

        this.movieService.getRecommendations(selected.title).subscribe({
          next: (response) => {
            if (requestToken !== this.recommendationLoadToken) return;
            this.loading = false;
            this.selectedMovieTitle = response.matchedTitle || selected.title;
            this.selectedMovie = response.selected || response.closestMatch || selected;
            const recs = Array.isArray(response.recommendations)
              ? response.recommendations
              : [];
            this.recommendations = recs;
            this.categoryMovies = [this.selectedMovie, ...recs].filter(Boolean) as MovieRecommendationItem[];
            this.quickMatches = Array.isArray(response.suggestions) && response.suggestions.length
              ? response.suggestions
              : matches;
          },
          error: () => {
            if (requestToken !== this.recommendationLoadToken) return;
            this.loading = false;
            this.selectedMovieTitle = selected.title;
            this.selectedMovie = selected;
            this.recommendations = [];
            this.categoryMovies = [selected];
          },
        });
      },
      error: (error) => {
        if (requestToken !== this.recommendationLoadToken) return;
        this.loading = false;
        this.selectedMovieTitle = '';
        this.selectedMovie = null;
        this.recommendations = [];
        this.quickMatches = [];
        this.searchError = error?.error?.message || 'We could not load recommendations for that movie.';
      },
    });
  }

  private runAutoSearch(value: string): void {
    const title = value.trim();
    if (!title) {
      this.resetState('');
      this.loadCategoryMovies();
      return;
    }
    if (title.length < 2) return;
    this.fetchRecommendations(title);
  }

  private resetState(message: string): void {
    this.recommendationLoadToken += 1;
    this.loading = false;
    this.searchError = message;
    this.closestMatchNote = '';
    this.emptyState = '';
    this.selectedMovieTitle = '';
    this.selectedMovie = null;
    this.recommendations = [];
    this.quickMatches = [];
  }

  private loadCategoryMovies(): void {
    const requestToken = ++this.categoryLoadToken;
    this.loading = true;
    this.searchError = '';
    this.emptyState = '';
    this.selectedMovie = null;
    this.selectedMovieTitle = '';
    this.recommendations = [];
    this.quickMatches = [];

    this.movieService.getMovies('', 1, 48).subscribe({
      next: (response) => {
        if (requestToken !== this.categoryLoadToken) return;
        let allMovies = Array.isArray(response.data) ? response.data : [];
        if (this.selectedGenre) {
          allMovies = allMovies.filter((movie) => 
            (movie.discoveryCategory || '').toLowerCase() === this.selectedGenre.toLowerCase()
          );
        }
        this.categoryMovies = allMovies;
        this.emptyState = this.categoryMovies.length
          ? ''
          : 'No movies found matching the selected filters.';
      },
      error: (error) => {
        if (requestToken !== this.categoryLoadToken) return;
        this.categoryMovies = [];
        this.searchError = error?.error?.message || 'Movie catalog could not be loaded.';
      },
      complete: () => {
        if (requestToken !== this.categoryLoadToken) return;
        this.loading = false;
      },
    });
  }

  trackMovie(_: number, movie: MovieRecommendationItem): string {
    return movie.movieId || movie.title;
  }
}
