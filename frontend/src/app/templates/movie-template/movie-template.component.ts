import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { ShowtimeSelectorComponent } from '../../shared/showtime-selector/showtime-selector.component';

@Component({
  standalone: true,
  selector: 'app-movie-template',
  imports: [CommonModule, DatePipe, ShowtimeSelectorComponent],
  templateUrl: './movie-template.component.html',
  styleUrls: ['./movie-template.component.css'],
})
export class MovieTemplateComponent {
  @Input() event: any;
  @Input() eventImageUrl = '';
  @Input() eventImgFailed = false;
  @Input() isFreeEvent = false;
  @Input() unitPriceRupees = 0;
  @Input() movieRecommendations: any[] = [];
  @Output() openBooking = new EventEmitter<void>();
  @Output() openMovie = new EventEmitter<any>();

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

  toggleLike(r: any): void {
    r.liked = !r.liked;
  }

  onImgError() {
    this.eventImgFailed = true;
  }
}
