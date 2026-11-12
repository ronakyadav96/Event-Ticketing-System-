import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { BRAND, BrandLogoComponent } from '../../theme/brand-logo.component';

@Component({
  selector: 'app-footer',
  standalone: true,
  imports: [CommonModule, RouterLink, BrandLogoComponent],
  templateUrl: './footer.component.html',
  styleUrls: ['./footer.component.css'],
})
export class FooterComponent {
  protected readonly brand = BRAND;
  year = new Date().getFullYear();
}
