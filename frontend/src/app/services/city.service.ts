import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

@Injectable({
  providedIn: 'root',
})
export class CityService {
  private readonly STORAGE_KEY = 'bm_selected_city';
  readonly popularCities = [
    'Mumbai',
    'Delhi-NCR',
    'Bengaluru',
    'Hyderabad',
    'Chandigarh',
    'Jaipur',
    'Pune',
    'Ahmedabad',
    'Kolkata',
    'Chennai',
  ];

  private citySubject = new BehaviorSubject<string>(this.getInitialCity());
  selectedCity$: Observable<string> = this.citySubject.asObservable();

  private getInitialCity(): string {
    const saved = localStorage.getItem(this.STORAGE_KEY);
    return saved && this.popularCities.includes(saved) ? saved : 'Mumbai';
  }

  get currentCity(): string {
    return this.citySubject.value;
  }

  setCity(city: string): void {
    if (!city) return;
    localStorage.setItem(this.STORAGE_KEY, city);
    this.citySubject.next(city);
  }
}
