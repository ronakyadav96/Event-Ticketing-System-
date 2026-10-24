import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CityService } from '../../services/city.service';

@Component({
  standalone: true,
  selector: 'app-city-selector',
  imports: [CommonModule, FormsModule],
  templateUrl: './city-selector.component.html',
  styleUrls: ['./city-selector.component.css'],
})
export class CitySelectorComponent {
  cityService = inject(CityService);

  showModal = false;
  searchQuery = '';

  get currentCity(): string {
    return this.cityService.currentCity;
  }

  get filteredCities(): string[] {
    const q = this.searchQuery.trim().toLowerCase();
    if (!q) return this.cityService.popularCities;
    return this.cityService.popularCities.filter((c) =>
      c.toLowerCase().includes(q)
    );
  }

  openModal(): void {
    this.showModal = true;
    this.searchQuery = '';
  }

  closeModal(): void {
    this.showModal = false;
  }

  selectCity(city: string): void {
    this.cityService.setCity(city);
    this.closeModal();
  }
}
