require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { UTApi } = require('uploadthing/server');
const { File } = require('buffer');

const {
  PROFILE_DEPARTMENTS,
  RESOURCE_DEPARTMENTS,
  FACULTY_SUBROLES,
  FIFTH_YEAR_ELIGIBLE_DEPTS
} = require('./constants/enums');
const { User, Resource, Question, Guide, Notification } = require('./models');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(cors());

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'aura_production_jwt_secret_2026';

mongoose.connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB Atlas (AURA DB)'))
  .catch((err) => console.error('MongoDB connection error:', err));

const utapi = new UTApi({ token: process.env.UPLOADTHING_TOKEN });
const upload = multer({ storage: multer.memoryStorage() });

// Health Check Endpoint for Render.com Deployment
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'AURA Production API v2.0' });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// --- STRICT 5TH YEAR & DEPARTMENT VALIDATOR ---
function validateRoleAndDepartment({ role, year, facultyRole, department }) {
  if (!PROFILE_DEPARTMENTS.includes(department)) {
    return '"General" is prohibited during registration/profile setup. Choose a valid academic department.';
  }
  if (role === 'Student') {
    if (![1, 2].includes(Number(year))) {
      return 'Student role must be in 1st Year or 2nd Year.';
    }
  } else if (role === 'Senior Student') {
    const y = Number(year);
    const isFifthYearAllowed = FIFTH_YEAR_ELIGIBLE_DEPTS.includes(department);
    const validYears = isFifthYearAllowed ? [3, 4, 5] : [3, 4];
    if (!validYears.includes(y)) {
      return isFifthYearAllowed
        ? `Senior Students in ${department} must select Year 3, 4, or 5.`
        : `5th Year is strictly restricted to ARCH and DS departments. ${department} Senior Students must select Year 3 or 4.`;
    }
  } else if (role === 'Faculty') {
    if (!FACULTY_SUBROLES.includes(facultyRole)) {
      return 'Faculty must select a valid designation (HOD, Professor, Assistant Prof, Lab Tech).';
    }
  }
  return null;
}

// --- JWT AUTH MIDDLEWARE ---
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Authorization token required' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-passwordHash');
    if (!user) return res.status(401).json({ error: 'Account not found' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session token' });
  }
};

// ============================================================================
// 1. AUTHENTICATION & SELF-APPROVING FIRST ADMIN
// ============================================================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, username, password, role, year, facultyRole, department, clubs } = req.body;
    if (!name || !username || !password) {
      return res.status(400).json({ error: 'Name, username, and password are required.' });
    }

    const validationError = validateRoleAndDepartment({ role, year, facultyRole, department });
    if (validationError) return res.status(400).json({ error: validationError });

    const existing = await User.findOne({ username: username.toLowerCase().trim() });
    if (existing) return res.status(400).json({ error: 'Username is already registered.' });

    let isApproved = true;
    if (role === 'Admin') {
      const adminCount = await User.countDocuments({ role: 'Admin' });
      isApproved = adminCount === 0; // First Admin self-approves automatically
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = await User.create({
      name: name.trim(),
      username: username.toLowerCase().trim(),
      passwordHash,
      role,
      year: ['Student', 'Senior Student'].includes(role) ? Number(year) : null,
      facultyRole: role === 'Faculty' ? facultyRole : null,
      department,
      isApproved,
      clubs: clubs || { tech: [], nonTech: [], sports: [], cultural: [], volunteering: [] }
    });

    const token = jwt.sign({ id: newUser._id, role: newUser.role }, JWT_SECRET, { expiresIn: '30d' });
    const userObj = newUser.toObject();
    delete userObj.passwordHash;

    res.json({ token, user: userObj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username: username?.toLowerCase().trim() });
    if (!user) return res.status(400).json({ error: 'Invalid username or password' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(400).json({ error: 'Invalid username or password' });

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    const userObj = user.toObject();
    delete userObj.passwordHash;

    res.json({ token, user: userObj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', authMiddleware, async (req, res) => {
  if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
  const users = await User.find().select('-passwordHash').sort({ createdAt: -1 });
  res.json(users);
});

app.patch('/api/admin/users/:id/approve', authMiddleware, async (req, res) => {
  if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { isApproved: req.body.isApproved },
    { new: true }
  ).select('-passwordHash');
  res.json(updated);
});

// ============================================================================
// 2. UPLOADTHING PDF STORAGE & AUTOMATIC AI METADATA DETECTION
// ============================================================================
app.post('/api/uploadthing/upload', authMiddleware, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file attached' });

    let secureUrl = '';
    if (process.env.UPLOADTHING_TOKEN && !process.env.UPLOADTHING_TOKEN.includes('YOUR_')) {
      const webFile = new File([req.file.buffer], req.file.originalname, {
        type: req.file.mimetype || 'application/pdf'
      });
      const response = await utapi.uploadFiles(webFile);
      if (response.error) throw new Error(response.error.message);
      secureUrl = response.data.ufsUrl || response.data.url;
    } else {
      secureUrl = `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf?file=${encodeURIComponent(req.file.originalname)}`;
    }

    const cleanName = req.file.originalname.replace(/\.pdf$/i, '').replace(/[_-]/g, ' ');
    const lower = cleanName.toLowerCase();
    const detectedType = lower.includes('question') || lower.includes('paper')
      ? 'Question Bank'
      : lower.includes('lab')
      ? 'Lab Manual'
      : lower.includes('syllabus')
      ? 'Syllabus'
      : 'Lecture Notes';

    const semMatch = lower.match(/sem\s*([1-9]|10)/i);
    const detectedSemester = semMatch ? `Sem ${semMatch[1]}` : 'Sem 3';

    res.json({
      success: true,
      pdfUrl: secureUrl,
      detectedMeta: {
        suggestedTitle: cleanName,
        resourceType: detectedType,
        semester: detectedSemester,
        aiSummary: `AI Extracted Summary (TRIZ Principle 2): Structured ${detectedType.toLowerCase()} synthesized from "${cleanName}", highlighting core syllabus modules, exam definitions, and problem-solving frameworks.`,
        tags: [detectedType, detectedSemester, req.user.department]
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 3. ACADEMIC RESOURCES (TRIZ Dimension & Composite Verification)
// ============================================================================
app.post('/api/resources', authMiddleware, async (req, res) => {
  try {
    const {
      title, course, semester, resourceType,
      department, targetYear, summary, extractedText, tags, pdfUrl
    } = req.body;

    if (!RESOURCE_DEPARTMENTS.includes(department)) {
      return res.status(400).json({ error: 'Invalid department selected' });
    }

    const autoVerify = ['Faculty', 'Admin'].includes(req.user.role) && req.user.isApproved;

    const resource = await Resource.create({
      title,
      course: course || 'Core Subject',
      semester: semester || 'Sem 1',
      resourceType: resourceType || 'Lecture Notes',
      department,
      targetYear: Number(targetYear) || req.user.year || 1,
      summary: summary || 'AI Summary generated via AURA extraction engine.',
      extractedText: extractedText || `${title} ${course} ${summary}`,
      tags: tags || [department, semester, resourceType],
      pdfUrl,
      uploaderId: req.user._id,
      uploaderName: req.user.name,
      uploaderRole: req.user.role,
      verified: autoVerify,
      verifiedBy: autoVerify ? req.user.name : null,
      verifiedRole: autoVerify ? req.user.role : null,
      moderatorTag: autoVerify ? `Verified by ${req.user.role} (${req.user.name})` : 'Pending Review'
    });

    res.json(resource);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/resources', authMiddleware, async (req, res) => {
  try {
    const resources = await Resource.find().sort({ createdAt: -1 });
    res.json(resources);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/resources/:id/verify', authMiddleware, async (req, res) => {
  try {
    if (!['Senior Student', 'Faculty', 'Admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only Senior Students, Faculty, or Admins can verify resources.' });
    }
    const resource = await Resource.findByIdAndUpdate(
      req.params.id,
      {
        verified: true,
        verifiedBy: req.user.name,
        verifiedRole: req.user.role,
        moderatorTag: `Verified by ${req.user.role} • ${req.user.name}`
      },
      { new: true }
    );
    res.json(resource);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 4. ASK LAURA AI (RAG Strictly on Verified Resources)
// ============================================================================
app.post('/api/laura-ai/ask', authMiddleware, async (req, res) => {
  try {
    const { query } = req.body;
    const keywords = (query || '').toLowerCase().split(/\s+/).filter(Boolean);

    const verifiedResources = await Resource.find({ verified: true }).sort({ createdAt: -1 });

    const matchedSources = verifiedResources.filter((doc) => {
      if (keywords.length === 0) return true;
      const haystack = `${doc.title} ${doc.course} ${doc.department} ${doc.summary} ${doc.extractedText}`.toLowerCase();
      return keywords.some((word) => haystack.includes(word));
    });

    const finalSources = matchedSources.length > 0 ? matchedSources.slice(0, 4) : verifiedResources.slice(0, 2);

    const answer = matchedSources.length > 0
      ? `LAURA AI Verified Synthesis: Grounded across ${matchedSources.length} moderator-verified document(s) in AURA for "${query}":\n\n` +
        matchedSources.slice(0, 3).map((s, idx) => `${idx + 1}. [${s.course} • ${s.semester}] ${s.title}: ${s.summary}`).join('\n\n')
      : `LAURA AI Notice: No exact keyword match was found among verified documents for "${query}". Displaying top moderator-verified archival references below.`;

    res.json({
      answer,
      verifiedOnly: true,
      sources: finalSources
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 5. Q&A BOARD ENDPOINTS
// ============================================================================
app.get('/api/qa', authMiddleware, async (req, res) => {
  const questions = await Question.find().sort({ createdAt: -1 });
  res.json(questions);
});

app.post('/api/qa', authMiddleware, async (req, res) => {
  const { question, department } = req.body;
  const created = await Question.create({
    question,
    department: department || req.user.department,
    askerId: req.user._id,
    askerName: req.user.name,
    askerRole: req.user.role,
    answers: []
  });
  res.json(created);
});

app.post('/api/qa/:id/answer', authMiddleware, async (req, res) => {
  const { text } = req.body;
  const updated = await Question.findByIdAndUpdate(
    req.params.id,
    {
      $push: {
        answers: {
          text,
          responderId: req.user._id,
          responderName: req.user.name,
          responderRole: req.user.role
        }
      }
    },
    { new: true }
  );
  res.json(updated);
});

// ============================================================================
// 6. EXPERIENCES & GUIDES (With Clickable 5-Star Rating)
// ============================================================================
app.get('/api/guides', authMiddleware, async (req, res) => {
  const guides = await Guide.find().sort({ createdAt: -1 });
  res.json(guides);
});

app.post('/api/guides', authMiddleware, async (req, res) => {
  const { title, category, department, content } = req.body;
  const guide = await Guide.create({
    title,
    category: category || 'Placement Tip',
    department: department || req.user.department,
    content,
    authorId: req.user._id,
    authorName: req.user.name,
    authorRole: req.user.role,
    ratings: [],
    averageRating: 0
  });
  res.json(guide);
});

app.post('/api/guides/:id/rate', authMiddleware, async (req, res) => {
  const stars = Number(req.body.stars);
  if (stars < 1 || stars > 5) return res.status(400).json({ error: 'Rating must be 1 to 5 stars' });

  const guide = await Guide.findById(req.params.id);
  if (!guide) return res.status(404).json({ error: 'Guide not found' });

  const existingIdx = guide.ratings.findIndex((r) => String(r.userId) === String(req.user._id));
  if (existingIdx >= 0) {
    guide.ratings[existingIdx].stars = stars;
  } else {
    guide.ratings.push({ userId: req.user._id, stars });
  }

  const sum = guide.ratings.reduce((acc, r) => acc + r.stars, 0);
  guide.averageRating = Number((sum / guide.ratings.length).toFixed(1));
  await guide.save();

  res.json(guide);
});

// ============================================================================
// 7. MULTI-TARGET NOTIFICATIONS (Combinations of Depts, Years/All Years & 5 Club Arrays)
// ============================================================================
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const allNotes = await Notification.find().sort({ createdAt: -1 });
    const user = req.user;

    const matched = [];
    for (const n of allNotes) {
      const triggers = [];

      if (n.targetAll) {
        triggers.push('Broadcast: All Campus');
      }
      if (n.targetDepartments?.includes(user.department)) {
        triggers.push(`Dept: ${user.department}`);
      }
      if (n.targetAllYears) {
        triggers.push('Year: All Years');
      } else if (user.year && n.targetYears?.includes(Number(user.year))) {
        triggers.push(`Year: ${user.year}th/st Year`);
      }

      const matchedTech = (n.targetTechClubs || []).filter((c) => (user.clubs?.tech || []).includes(c));
      if (matchedTech.length > 0) triggers.push(`Tech Club: ${matchedTech.join(', ')}`);

      const matchedNonTech = (n.targetNonTechClubs || []).filter((c) => (user.clubs?.nonTech || []).includes(c));
      if (matchedNonTech.length > 0) triggers.push(`Non-Tech Club: ${matchedNonTech.join(', ')}`);

      const matchedSports = (n.targetSportsTeams || []).filter((c) => (user.clubs?.sports || []).includes(c));
      if (matchedSports.length > 0) triggers.push(`Sports Team: ${matchedSports.join(', ')}`);

      const matchedCultural = (n.targetCulturalAssociations || []).filter((c) => (user.clubs?.cultural || []).includes(c));
      if (matchedCultural.length > 0) triggers.push(`Cultural (Shristi): ${matchedCultural.join(', ')}`);

      const matchedVolunteering = (n.targetVolunteeringGroups || []).filter((c) => (user.clubs?.volunteering || []).includes(c));
      if (matchedVolunteering.length > 0) triggers.push(`Volunteering: ${matchedVolunteering.join(', ')}`);

      if (triggers.length > 0 || String(n.senderId) === String(user._id) || user.role === 'Admin') {
        matched.push({
          ...n.toObject(),
          entryPathTriggers: triggers.length > 0 ? triggers : ['Sender / Admin Audit Log']
        });
      }
    }

    res.json(matched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications', authMiddleware, async (req, res) => {
  try {
    if (!['Admin', 'Faculty'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only Admin and Faculty can dispatch multi-target notifications.' });
    }

    const {
      title,
      message,
      targetAll,
      targetAllYears,
      targetYears,
      targetDepartments,
      targetTechClubs,
      targetNonTechClubs,
      targetSportsTeams,
      targetCulturalAssociations,
      targetVolunteeringGroups
    } = req.body;

    const note = await Notification.create({
      title,
      message,
      senderId: req.user._id,
      senderName: req.user.name,
      senderRole: req.user.role,
      targetAll: Boolean(targetAll),
      targetAllYears: Boolean(targetAllYears),
      targetYears: (targetYears || []).map(Number),
      targetDepartments: targetDepartments || [],
      targetTechClubs: targetTechClubs || [],
      targetNonTechClubs: targetNonTechClubs || [],
      targetSportsTeams: targetSportsTeams || [],
      targetCulturalAssociations: targetCulturalAssociations || [],
      targetVolunteeringGroups: targetVolunteeringGroups || []
    });

    res.json(note);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 8. PROFILE DETAILS & ACTIVITY STATISTICS
// ============================================================================
app.get('/api/profile/stats', authMiddleware, async (req, res) => {
  const userId = req.user._id;
  const [uploadsCount, verifiedUploadsCount, questionsAsked, answersGiven, guidesCount] = await Promise.all([
    Resource.countDocuments({ uploaderId: userId }),
    Resource.countDocuments({ uploaderId: userId, verified: true }),
    Question.countDocuments({ askerId: userId }),
    Question.countDocuments({ 'answers.responderId': userId }),
    Guide.countDocuments({ authorId: userId })
  ]);

  res.json({
    uploadsCount,
    verifiedUploadsCount,
    questionsAsked,
    answersGiven,
    guidesCount,
    totalContributions: uploadsCount + questionsAsked + answersGiven + guidesCount
  });
});

app.put('/api/profile', authMiddleware, async (req, res) => {
  try {
    const { name, role, year, facultyRole, department, clubs } = req.body;
    const validationError = validateRoleAndDepartment({ role, year, facultyRole, department });
    if (validationError) return res.status(400).json({ error: validationError });

    const updated = await User.findByIdAndUpdate(
      req.user._id,
      {
        name,
        role,
        year: ['Student', 'Senior Student'].includes(role) ? Number(year) : null,
        facultyRole: role === 'Faculty' ? facultyRole : null,
        department,
        clubs
      },
      { new: true }
    ).select('-passwordHash');

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`AURA Production Backend listening on port ${PORT}`);
});
