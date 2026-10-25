const mongoose = require('mongoose');
const {
  PROFILE_DEPARTMENTS,
  RESOURCE_DEPARTMENTS,
  ROLES,
  FACULTY_SUBROLES
} = require('../constants/enums');

// 1. USER SCHEMA
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  username: { type: String, required: true, unique: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ROLES, required: true },
  year: { type: Number, enum: [1, 2, 3, 4, 5, null], default: null },
  facultyRole: { type: String, enum: [...FACULTY_SUBROLES, null], default: null },
  department: {
    type: String,
    enum: PROFILE_DEPARTMENTS,
    required: true
  },
  isApproved: { type: Boolean, default: true },
  clubs: {
    tech: { type: [String], default: [] },
    nonTech: { type: [String], default: [] },
    sports: { type: [String], default: [] },
    cultural: { type: [String], default: [] },
    volunteering: { type: [String], default: [] }
  }
}, { timestamps: true });

// 2. RESOURCE SCHEMA (TRIZ Dimension + Composite Materials Rules)
const ResourceSchema = new mongoose.Schema({
  title: { type: String, required: true },
  course: { type: String, required: true, default: 'Core Engineering' },
  semester: { type: String, required: true, default: 'Sem 1' },
  resourceType: {
    type: String,
    enum: ['Lecture Notes', 'Question Bank', 'Lab Manual', 'Syllabus', 'Reference Book'],
    default: 'Lecture Notes'
  },
  department: { type: String, enum: RESOURCE_DEPARTMENTS, required: true },
  targetYear: { type: Number, default: 1 },
  summary: { type: String, required: true },
  extractedText: { type: String, default: '' },
  tags: { type: [String], default: [] },
  pdfUrl: { type: String, required: true },
  uploaderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  uploaderName: { type: String, required: true },
  uploaderRole: { type: String, required: true },
  verified: { type: Boolean, default: false },
  verifiedBy: { type: String, default: null },
  verifiedRole: { type: String, default: null },
  moderatorTag: { type: String, default: 'Pending Verification' },
  peerFeedbackScore: { type: Number, default: 4.9 }
}, { timestamps: true });

// 3. Q&A BOARD SCHEMA
const QuestionSchema = new mongoose.Schema({
  question: { type: String, required: true },
  department: { type: String, enum: RESOURCE_DEPARTMENTS, default: 'General' },
  askerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  askerName: { type: String, required: true },
  askerRole: { type: String, required: true },
  answers: [{
    text: { type: String, required: true },
    responderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    responderName: { type: String, required: true },
    responderRole: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

// 4. EXPERIENCES & GUIDES SCHEMA
const GuideSchema = new mongoose.Schema({
  title: { type: String, required: true },
  category: {
    type: String,
    enum: ['Placement Tip', 'Course Experience', 'Study Hack', 'Internship Guide', 'Campus Life'],
    default: 'Placement Tip'
  },
  department: { type: String, enum: RESOURCE_DEPARTMENTS, default: 'General' },
  content: { type: String, required: true },
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  authorName: { type: String, required: true },
  authorRole: { type: String, required: true },
  ratings: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    stars: { type: Number, min: 1, max: 5 }
  }],
  averageRating: { type: Number, default: 0 }
}, { timestamps: true });

// 5. UPGRADED MULTI-TARGET NOTIFICATIONS SCHEMA
// Supports combinations across all distinct club/group arrays, departments, and specific years or "All Years"
const NotificationSchema = new mongoose.Schema({
  title: { type: String, required: true },
  message: { type: String, required: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderName: { type: String, required: true },
  senderRole: { type: String, required: true },
  targetAll: { type: Boolean, default: false },
  targetAllYears: { type: Boolean, default: false },
  targetYears: { type: [Number], default: [] },
  targetDepartments: { type: [String], default: [] },
  targetTechClubs: { type: [String], default: [] },
  targetNonTechClubs: { type: [String], default: [] },
  targetSportsTeams: { type: [String], default: [] },
  targetCulturalAssociations: { type: [String], default: [] },
  targetVolunteeringGroups: { type: [String], default: [] }
}, { timestamps: true });

module.exports = {
  User: mongoose.model('User', UserSchema),
  Resource: mongoose.model('Resource', ResourceSchema),
  Question: mongoose.model('Question', QuestionSchema),
  Guide: mongoose.model('Guide', GuideSchema),
  Notification: mongoose.model('Notification', NotificationSchema)
};