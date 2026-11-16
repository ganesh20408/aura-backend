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
    enum: [...PROFILE_DEPARTMENTS, 'Administration', null],
    default: null
  },
  isApproved: { type: Boolean, default: true },
  isPrimaryAdmin: { type: Boolean, default: false },
  isPlacementInCharge: { type: Boolean, default: false },
  placementDepartment: { type: String, default: null },
  pushTokens: { type: [String], default: [] },
  clubs: {
    tech: { type: [String], default: [] },
    nonTech: { type: [String], default: [] },
    sports: { type: [String], default: [] },
    cultural: { type: [String], default: [] },
    volunteering: { type: [String], default: [] }
  },
  plusUltraPoints: { type: Number, default: 0 },
  badges: { type: [String], default: [] },
  isGraduated: { type: Boolean, default: false }
}, { timestamps: true });

// 2. RESOURCE SCHEMA (TRIZ Dimension + Composite Materials Rules)
const ResourceSchema = new mongoose.Schema({
  title: { type: String, required: true },
  course: { type: String, required: true, default: 'Core Engineering' },
  semester: { type: String, default: null }, // Optional semester
  resourceType: {
    type: String,
    enum: ['Lecture Notes', 'Question Bank', 'Lab Manual', 'Syllabus', 'Reference Book'],
    default: 'Lecture Notes'
  },
  department: { type: String, enum: RESOURCE_DEPARTMENTS, required: true },
  targetYear: { type: Number, default: 0 }, // 0 = All Years
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
  department: { type: String, enum: RESOURCE_DEPARTMENTS, default: 'All' },
  clubCategory: { type: String, enum: ['Tech', 'Non-Tech', 'Sports', 'Cultural', 'Volunteering', null], default: null },
  clubName: { type: String, default: null },
  askerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  askerName: { type: String, required: true },
  askerRole: { type: String, required: true },
  answers: [{
    text: { type: String, required: true },
    responderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    responderName: { type: String, required: true },
    responderRole: { type: String, required: true },
    isAccepted: { type: Boolean, default: false },
    upvotes: { type: Number, default: 0 },
    upvoters: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
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
  department: { type: String, enum: RESOURCE_DEPARTMENTS, default: 'All' },
  content: { type: String, required: true },
  tags: { type: [String], default: [] },
  topics: { type: [String], default: [] },
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

// 6. HIRING & JOB UPDATES SCHEMA (Per-Department Approvals + Global Admin Override)
const JobUpdateSchema = new mongoose.Schema({
  company: { type: String, required: true },
  role: { type: String, required: true },
  jobType: { type: String, enum: ['Internship', 'Full-Time', 'Part-Time', 'Hiring Challenge'], default: 'Internship' },
  description: { type: String, required: true },
  applyUrl: { type: String, required: true },
  sourceUrl: { type: String, default: '' },
  location: { type: String, default: 'On-site / Hybrid' },
  stipendOrSalary: { type: String, default: 'Competitive' },
  deadline: { type: String, default: '' },
  targetDepartments: { type: [String], default: [] },
  targetYears: { type: [Number], default: [3, 4] },
  creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  creatorName: { type: String, default: 'Placement Coordinator' },
  creatorRole: { type: String, default: 'Admin' },
  departmentApprovals: [{
    department: { type: String, required: true },
    status: { type: String, enum: ['Pending', 'Published', 'Rejected'], default: 'Pending' },
    approvedBy: { type: String, default: null },
    approvedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    notifiedCount: { type: Number, default: 0 }
  }],
  isGloballyPublished: { type: Boolean, default: false },
  globalApprovedBy: { type: String, default: null },
  globalApprovedAt: { type: Date, default: null }
}, { timestamps: true });

// 7. BUG REPORTS & SUPPORT TICKETS SCHEMA
const BugReportSchema = new mongoose.Schema({
  category: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
  severity: { type: String, enum: ['Low', 'Medium', 'High', 'Critical'], default: 'Medium' },
  screenshotUrl: { type: String, default: null },
  deviceInfo: {
    os: { type: String, default: 'Unknown' },
    osVersion: { type: String, default: 'Unknown' },
    appVersion: { type: String, default: '2.0.0' },
    screenDimensions: { type: String, default: '' },
    deviceBrand: { type: String, default: '' },
    platform: { type: String, default: '' }
  },
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reporterName: { type: String, required: true },
  reporterRole: { type: String, required: true },
  reporterDepartment: { type: String, default: null },
  reporterUsername: { type: String, default: '' },
  status: { type: String, enum: ['Open', 'Investigating', 'Resolved', 'Closed'], default: 'Open' },
  adminNotes: { type: String, default: '' },
  resolvedAt: { type: Date, default: null },
  resolvedBy: { type: String, default: null }
}, { timestamps: true });

module.exports = {
  User: mongoose.model('User', UserSchema),
  Resource: mongoose.model('Resource', ResourceSchema),
  Question: mongoose.model('Question', QuestionSchema),
  Guide: mongoose.model('Guide', GuideSchema),
  Notification: mongoose.model('Notification', NotificationSchema),
  JobUpdate: mongoose.model('JobUpdate', JobUpdateSchema),
  BugReport: mongoose.model('BugReport', BugReportSchema)
};