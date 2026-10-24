import { Injectable, signal } from '@angular/core';

/**
 * Search state shared between the events page and its search box.
 * (Booking state lives only in the AI chat, owned by the server — see ChatService.)
 */
@Injectable({
  providedIn: 'root',
})
export class BookingAssistantService {
  activeSearchQuery = signal<string>('');
  searchResults = signal<any[]>([]);
  selectedItem = signal<any | null>(null);

  setSearchQuery(query: string, results: any[] = []): void {
    this.activeSearchQuery.set(query.trim());
    if (results && results.length) {
      this.searchResults.set(results);
    }
  }

  setSearchResults(results: any[]): void {
    this.searchResults.set(results || []);
  }

  selectItem(item: any): void {
    this.selectedItem.set(item);
  }
}
