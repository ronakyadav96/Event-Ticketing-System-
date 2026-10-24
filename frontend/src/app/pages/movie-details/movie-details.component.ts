import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { MovieRecommendationItem } from '../../models/movie.model';
import { EventService } from '../../services/event.service';
import { MovieService } from '../../services/movie.service';

@Component({
  selector: 'app-movie-details',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './movie-details.component.html',
  styleUrls: ['./movie-details.component.css'],
})
export class MovieDetailsComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private movieService = inject(MovieService);
  private eventService = inject(EventService);

  loading = true;
  error = '';
  movie: MovieRecommendationItem | null = null;
  relatedEvents: any[] = [];
  eventsLoading = false;
  eventsError = '';
  recommendations: MovieRecommendationItem[] = [];

  readonly hashtags = [
    { tag: '#Inspiring', count: '65,041' },
    { tag: '#AwesomeStory', count: '58,108' },
    { tag: '#SuperDirection', count: '56,387' },
    { tag: '#GreatActing', count: '54,130' },
    { tag: '#Blockbuster', count: '48,920' },
  ];

  readonly reviews = [
    {
      name: 'Shravan Gupta',
      rating: '10/10',
      tags: '#SuperDirection #GreatActing #WowMusic',
      text: 'Bahut hi zabardast movie hai! 🔥 Story aur screenplay ko jis tarah se present kiya gaya hai, woh truly inspiring aur engaging hai. Direction, visuals, music... ekdum mindblowing experience!',
      likes: '7.2K',
      time: '10 Days ago',
      liked: false
    },
    {
      name: 'Aryaman Sharma',
      rating: '10/10',
      tags: '#SuperDirection #GreatActing #WowMusic',
      text: 'Don\'t have enough words to express how touching the story is. Literally have goosebumps writing this review. Definitely a must watch in the theatre with family and friends! :)',
      likes: '5.1K',
      time: '14 Days ago',
      liked: false
    },
    {
      name: 'Pooja Verma',
      rating: '9/10',
      tags: '#Inspiring #VisualMasterpiece',
      text: 'The VFX and emotional depth in the second half completely exceeded my expectations. Top notch background score and acting. Highly recommended for cinema halls!',
      likes: '3.8K',
      time: '18 Days ago',
      liked: false
    }
  ];

  ngOnInit(): void {
    const movieId = String(this.route.snapshot.paramMap.get('movieId') || '').trim();
    if (!movieId) {
      this.loading = false;
      this.error = 'Movie id is required.';
      return;
    }

    this.eventService.getMovieEvent(movieId).subscribe({
      next: (event) => {
        const eventId = event?._id || event?.id;
        if (eventId) {
          this.router.navigate(['/events', eventId]);
          return;
        }
        this.loadMovieDetails(movieId);
      },
      error: () => {
        this.loadMovieDetails(movieId);
      },
    });
  }

  private loadMovieDetails(movieId: string): void {
    this.movieService.getMovieById(movieId).subscribe({
      next: (response) => {
        this.movie = response.movie;
        this.loading = false;
        this.loadRecommendations(response.movie.title);
        this.loadRelatedEvents(movieId, response.movie.title);
      },
      error: (error) => {
        this.loading = false;
        this.error = error?.error?.message || 'Movie details could not be loaded.';
      },
    });
  }

  openEvent(event: any): void {
    const id = event?._id || event?.id;
    if (!id) return;
    this.router.navigate(['/events', id]);
  }

  bookTickets(): void {
    if (this.relatedEvents.length) {
      this.openEvent(this.relatedEvents[0]);
    } else {
      this.router.navigate(['/events'], { queryParams: { q: this.movie?.title } });
    }
  }

  toggleLike(r: any): void {
    r.liked = !r.liked;
  }

  posterStyle(movie: MovieRecommendationItem | null): Record<string, string> {
    return movie?.posterUrl ? { 'background-image': `url('${movie.posterUrl}')` } : {};
  }

  trackMovie(_: number, movie: MovieRecommendationItem): string {
    return movie.movieId || movie.title;
  }

  private loadRecommendations(title: string): void {
    if (!title.trim()) return;

    this.movieService.getRecommendations(title, 6).subscribe({
      next: (response) => {
        this.recommendations = Array.isArray(response.recommendations) ? response.recommendations : [];
      },
      error: () => {
        this.recommendations = [];
      },
    });
  }

  private loadRelatedEvents(movieId: string, title: string): void {
    if (!movieId.trim() && !title.trim()) return;
    this.eventsLoading = true;
    this.eventsError = '';

    this.eventService.getAllEvents(undefined, 1, 12, movieId.trim() ? undefined : title).subscribe({
      next: (response) => {
        const list = Array.isArray(response?.data) ? response.data : [];
        this.relatedEvents = list;
        this.eventsLoading = false;
      },
      error: () => {
        this.relatedEvents = [];
        this.eventsLoading = false;
      },
    });
  }
}
