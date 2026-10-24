import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';

import { AuthService } from '../../auth/auth.service';
import { PromotionKind, PromotionRecord, PromotionService } from '../../services/promotion.service';

@Component({
  standalone: true,
  selector: 'app-promotions',
  imports: [CommonModule],
  templateUrl: './promotions.component.html',
  styleUrls: ['./promotions.component.css'],
})
export class PromotionsComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private authService = inject(AuthService);
  private promotionService = inject(PromotionService);

  pageKind: PromotionKind = 'gift';
  title = 'Gift Offers';
  subtitle = 'Claim exclusive gifts and use them in your bookings.';
  feedbackMessage = '';
  claimablePromotions: PromotionRecord[] = [];
  claimedPromotions: PromotionRecord[] = [];

  get currentUser() {
    return this.authService.getUser();
  }

  ngOnInit(): void {
    this.route.data.subscribe((data) => {
      const kind = data?.['kind'] === 'coupon' ? 'coupon' : 'gift';
      this.pageKind = kind;
      this.title = kind === 'gift' ? 'Gift Offers' : 'Coupon Offers';
      this.subtitle = kind === 'gift'
        ? 'Claim exclusive gifts and use them in your bookings.'
        : 'Claim coupons here and apply them while booking.';
      this.refreshPromotions();
    });
  }

  claimPromotion(id: string): void {
    const result = this.promotionService.claimPromotion(id, this.currentUser);
    this.feedbackMessage = result.message;
    this.refreshPromotions();
  }

  promotionCaption(item: PromotionRecord): string {
    return this.promotionService.describePromotion(item);
  }

  private refreshPromotions(): void {
    const user = this.currentUser;
    this.claimablePromotions = this.promotionService
      .listClaimableForUser(user)
      .filter((item) => item.kind === this.pageKind);
    this.claimedPromotions = this.promotionService
      .listClaimedForUser(user)
      .filter((item) => item.kind === this.pageKind);
  }
}
