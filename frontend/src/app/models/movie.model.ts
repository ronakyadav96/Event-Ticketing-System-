export interface MovieRecommendationItem {
  movieId: string;
  title: string;
  overview: string;
  releaseDate: string;
  voteAverage: number;
  popularity: number;
  posterPath: string;
  posterUrl: string;
  hasPoster: boolean;
  discoveryCategory?: string;
  similarityScore?: number;
}

export interface MovieSearchResponse {
  ok: boolean;
  query?: string;
  normalizedQuery?: string;
  exactMatch?: boolean;
  closestMatch?: MovieRecommendationItem;
  results: MovieRecommendationItem[];
}

export interface MovieListResponse {
  ok: boolean;
  data: MovieRecommendationItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export interface MovieDetailResponse {
  ok: boolean;
  movie: MovieRecommendationItem;
  posterConfig?: {
    apiKeyConfigured: boolean;
    imageBaseUrl: string;
  };
}

export interface MovieRecommendationResponse {
  ok: boolean;
  matchedTitle?: string;
  exactMatch?: boolean;
  selected?: MovieRecommendationItem;
  closestMatch?: MovieRecommendationItem;
  recommendations: MovieRecommendationItem[];
  suggestions?: MovieRecommendationItem[];
  message?: string;
  posterConfig?: {
    apiKeyConfigured: boolean;
    imageBaseUrl: string;
  };
}
