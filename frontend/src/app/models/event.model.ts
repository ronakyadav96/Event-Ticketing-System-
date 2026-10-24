export interface Event {
  _id?: string;
  id?: string;              // ✅ optional
  title: string;
  description?: string;     // ✅ optional
  date: string;
  startDate?: string;
  endDate?: string;
  showTimes?: string[];
  venue: string;
  price: number;
  totalSeats: number;
  bookedSeats?: number;     // ✅ optional
  category?: string;
  city?: string;
  language?: string;
  ageRestriction?: string;
  tagline?: string;
  durationMinutes?: number | null;
  featured?: boolean;
  imageUrl?: string;
  isUpcoming?: boolean;
  movieMeta?: { voteAverage?: number; posterUrl?: string; releaseDate?: string; tags?: string };
  registrationTemplate?: string;
  designTemplate?: string;
  designConfig?: Record<string, any>;
  customFields?: Array<{
    label: string;
    type: string;
    required?: boolean;
    options?: string[];
  }>;
}
