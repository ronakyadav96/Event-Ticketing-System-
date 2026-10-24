

import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HeroService, HeroImageDto } from '../../services/hero.service';
import { Subject, takeUntil } from 'rxjs';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-hero-carousel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './hero-carousel.component.html',
  styleUrls: ['./hero-carousel.component.css'],
})
export class HeroCarouselComponent implements OnInit, OnDestroy {
  private hero = inject(HeroService);
  private destroy$ = new Subject<void>();

  images: HeroImageDto[] = [];
  activeIndex = 0;
  private timer: any = null;

  ngOnInit(): void {
    this.hero
      .getPublicHeroImages()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (imgs) => {
          this.images = Array.isArray(imgs) ? imgs.slice(0, 6) : [];
          this.activeIndex = 0;
          this.resume();
        },
        error: () => {
          this.images = [];
          this.pause();
        },
      });
  }

  imgSrc(img: HeroImageDto): string {
    const base = environment.apiUrl.replace(/\/+$/, '');
    const url = String(img?.url || '');
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    return url.startsWith('/') ? `${base}${url}` : `${base}/${url}`;
  }

  next(): void {
    if (this.images.length <= 1) return;
    this.activeIndex = (this.activeIndex + 1) % this.images.length;
  }

  prev(): void {
    if (this.images.length <= 1) return;
    this.activeIndex = (this.activeIndex - 1 + this.images.length) % this.images.length;
  }

  goTo(i: number): void {
    if (!this.images.length) return;
    const idx = Number(i);
    if (isNaN(idx)) return;
    this.activeIndex = Math.min(Math.max(0, idx), this.images.length - 1);
  }

  pause(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  resume(): void {
    if (this.images.length <= 1) return;
    if (this.timer) return;
    this.timer = setInterval(() => this.next(), 2000);
  }

  ngOnDestroy(): void {
    this.pause();
    this.destroy$.next();
    this.destroy$.complete();
  }
}

