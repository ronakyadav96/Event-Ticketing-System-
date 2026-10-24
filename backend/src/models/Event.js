// src/models/Event.js
const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },

    description: {
      type: String,
      default: "",
      maxlength: 2000,
    },

    // Primary (legacy) datetime for the event (kept for backward compatibility)
    date: {
      type: Date,
      required: true,
    },

    // New: date range + show times (BookMyShow-style)
    // startDate/endDate are stored as UTC midnight of selected dates
    startDate: {
      type: Date,
      default: null,
    },

    endDate: {
      type: Date,
      default: null,
    },

    // Array of "HH:mm" strings (24h)
    showTimes: {
      type: [String],
      default: [],
    },

    venue: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },

    price: {
      type: Number,
      required: true,
      min: 0,
    },
    category: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    locationType: {
      type: String,
      default: '',
      trim: true,
      maxlength: 40,
    },

    // City the event takes place in. Empty = shown in every city (e.g. nationwide movie releases).
    city: {
      type: String,
      default: '',
      trim: true,
      maxlength: 60,
    },

    // Listing details shown on cards and the details page (BookMyShow-style).
    language: {
      type: String,
      default: '',
      trim: true,
      maxlength: 80,
    },
    ageRestriction: {
      type: String,
      default: '',
      trim: true,
      maxlength: 20,
    },
    tagline: {
      type: String,
      default: '',
      trim: true,
      maxlength: 160,
    },
    durationMinutes: {
      type: Number,
      default: null,
      min: 0,
    },
    featured: {
      type: Boolean,
      default: false,
    },

    totalSeats: {
      type: Number,
      required: true,
      min: 1,
    },

    bookedSeats: {
      type: Number,
      default: 0,
      min: 0,
    },

    // 🔥 VERY IMPORTANT FOR DASHBOARD FILTERING
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Image (GridFS or relative path)
    imageUrl: {
      type: String,
      default: "",
    },

    imageFileId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    registrationTemplate: {
      type: String,
      default: "standard",
    },

    designTemplate: {
      type: String,
      default: "clean-hero",
    },
    imagePreset: {
      type: String,
      default: "preset-a",
    },

    designConfig: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    customFields: [
      {
        label: { type: String, required: true, maxlength: 80 },
        type: {
          type: String,
          enum: ["text", "email", "phone", "number", "textarea", "select", "checkbox"],
          default: "text",
        },
        required: { type: Boolean, default: false },
        options: [{ type: String }],
      },
    ],

    sourceType: {
      type: String,
      default: '',
      trim: true,
      maxlength: 40,
    },

    // Unique (sparse) in MongoDB: leave unset for events that are not movie imports — an empty
    // string would collide with every other hand-created event.
    sourceMovieId: {
      type: String,
      trim: true,
      maxlength: 40,
    },

    movieMeta: {
      tags: {
        type: String,
        default: '',
      },
      releaseDate: {
        type: String,
        default: '',
      },
      posterPath: {
        type: String,
        default: '',
      },
      posterUrl: {
        type: String,
        default: '',
      },
      voteAverage: {
        type: Number,
        default: 0,
      },
      popularity: {
        type: Number,
        default: 0,
      },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// =====================================================
// 🔹 INDEXES (Important for performance)
// =====================================================
eventSchema.index({ createdBy: 1 });
eventSchema.index({ date: 1 });
eventSchema.index({ category: 1, date: 1 });
eventSchema.index({ startDate: 1, endDate: 1 });
eventSchema.index({ sourceMovieId: 1 });
eventSchema.index({ city: 1, category: 1 });


// =====================================================
// 🔹 Virtual: Available Seats
// =====================================================
eventSchema.virtual("availableSeats").get(function () {
  const total = Number(this.totalSeats || 0);
  const booked = Number(this.bookedSeats || 0);
  return Math.max(total - booked, 0);
});


// =====================================================
// 🔹 Virtual: Sold Out
// =====================================================
eventSchema.virtual("isSoldOut").get(function () {
  return this.availableSeats <= 0;
});


// =====================================================
// 🔹 Safety Before Save
// =====================================================
eventSchema.pre("save", function () {
  if (this.bookedSeats > this.totalSeats) {
    this.bookedSeats = this.totalSeats;
  }

  if (this.bookedSeats < 0) {
    this.bookedSeats = 0;
  }

  // Backward compatibility: if start/end dates are not set, derive from `date`
  if (!this.startDate && this.date) {
    const d = new Date(this.date);
    if (!Number.isNaN(d.getTime())) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      this.startDate = new Date(`${y}-${m}-${day}T00:00:00.000Z`);
    }
  }

  if (!this.endDate && this.startDate) {
    this.endDate = this.startDate;
  }

  if ((!this.showTimes || !this.showTimes.length) && this.date) {
    const d = new Date(this.date);
    if (!Number.isNaN(d.getTime())) {
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      this.showTimes = [`${hh}:${mm}`];
    }
  }
});


// =====================================================
// 🔹 Clean Response Transformation (optional)
// =====================================================
eventSchema.set("toJSON", {
  transform: function (doc, ret) {
    ret.id = ret._id;
    delete ret.__v;
    return ret;
  },
});


module.exports = mongoose.model("Event", eventSchema);
