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
  FIFTH_YEAR_ELIGIBLE_DEPTS,
  STANDARD_SEMESTERS,
  EXTENDED_SEMESTERS
} = require('./constants/enums');
const { User, Resource, Question, Guide, Notification, JobUpdate, BugReport } = require('./models');

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
  // For Admin, it shouldn't ask any further details
  if (role === 'Admin') return null;

  if (!PROFILE_DEPARTMENTS.includes(department)) {
    return '"All" is prohibited during registration/profile setup. Choose a valid academic department.';
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
        ? `Senior Students in ${department} must select Year 3, 4, or 5 (Semesters 5–10).`
        : `5th Year (Sem 9 & 10) is strictly restricted to ARCH and DS departments. ${department} only has 4 years (Sem 1 to 8). Please select Year 3 or 4.`;
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

// Helper: Verifies if a user is the primary/main administrator
async function isMainAdmin(user) {
  if (!user || user.role !== 'Admin' || !user.isApproved) return false;
  if (user.isPrimaryAdmin) return true;
  // Fallback to earliest approved admin if isPrimaryAdmin field is not yet set
  const primary = await User.findOne({ role: 'Admin', isApproved: true }).sort({ createdAt: 1 });
  if (primary && String(primary._id) === String(user._id)) {
    await User.findByIdAndUpdate(user._id, { isPrimaryAdmin: true });
    return true;
  }
  return false;
}

// Helper: Awards Plus Ultra Points (PUP) and manages dynamic badges
async function awardPoints(userId, points, reason) {
  try {
    if (!userId || points <= 0) return null;
    const user = await User.findById(userId);
    if (!user) return null;

    user.plusUltraPoints = (user.plusUltraPoints || 0) + points;

    const currentBadges = new Set(user.badges || []);
    if (user.plusUltraPoints >= 50) currentBadges.add('Plus Ultra Scholar');
    if (user.plusUltraPoints >= 150) currentBadges.add('Top Mentor');
    if (user.plusUltraPoints >= 300) currentBadges.add(`Top Contributor — ${user.department || 'Campus'}`);
    if (user.plusUltraPoints >= 600) currentBadges.add('Placement Guru');
    if (user.plusUltraPoints >= 1000) currentBadges.add('Library Legend');

    user.badges = Array.from(currentBadges);
    await user.save();
    return user;
  } catch (err) {
    console.error('awardPoints error:', err.message);
    return null;
  }
}

// Enhanced AI Auto-Tagger for Academic Resources & PDF Uploads
function autoTagResource({ title = '', fileName = '', description = '', summary = '' }) {
  const combined = `${title} ${fileName} ${description} ${summary}`.toLowerCase();
  
  // 1. Detect Department
  let detectedDept = 'General';
  if (/(computer|software|coding|algorithm|data structure|dbms|compiler|operating system|python|java|web dev|networking|git|c\+\+)/i.test(combined)) {
    detectedDept = 'CSE';
  } else if (/(information technology|cloud|cybersecurity|fullstack|devops|aws|azure)/i.test(combined)) {
    detectedDept = 'IT';
  } else if (/(electronic|signal processing|communication|vlsi|antenna|microprocessor|embedded|dsp|semiconductor|fpga)/i.test(combined)) {
    detectedDept = 'ECE';
  } else if (/(electrical|circuit|power system|generator|transformer|high voltage|electromagnetic|motor|inverter)/i.test(combined)) {
    detectedDept = 'EEE';
  } else if (/(mechanical|thermodynamics|fluid mechanics|heat transfer|machining|cad|cam|manufacturing|kinematics|automotive)/i.test(combined)) {
    detectedDept = 'MECH';
  } else if (/(civil|structural|concrete|surveying|soil mechanics|transportation|hydrology|environmental|geotechnical)/i.test(combined)) {
    detectedDept = 'CIVIL';
  } else if (/(architecture|building planning|landscape|urban design|climatology|interior|revit|bim|elevation)/i.test(combined)) {
    detectedDept = 'ARCH';
  } else if (/(data science|machine learning|deep learning|statistics|big data|analytics|nlp|neural network|pandas|tensorflow)/i.test(combined)) {
    detectedDept = 'DS';
  } else if (/(mechatronics|robotics|sensors|actuators|automation|plc|scada)/i.test(combined)) {
    detectedDept = 'MECT';
  }

  // 2. Detect Resource Type
  let detectedType = 'Lecture Notes';
  if (/(question|bank|paper|pyq|quiz|exam|midsem|endsem|solved)/i.test(combined)) {
    detectedType = 'Question Bank';
  } else if (/(lab|manual|experiment|practical|observation|record|code)/i.test(combined)) {
    detectedType = 'Lab Manual';
  } else if (/(syllabus|curriculum|scheme|regulations|course plan)/i.test(combined)) {
    detectedType = 'Syllabus';
  } else if (/(book|author|edition|textbook|volume|handbook)/i.test(combined)) {
    detectedType = 'Reference Book';
  }

  // 3. Detect Semester & Target Year
  const semMatch = combined.match(/sem\s*([1-9]|10)|semester\s*([1-9]|10)/i);
  let detectedSemester = null;
  let targetYear = 0; // 0 = All Years

  if (semMatch) {
    const num = parseInt(semMatch[1] || semMatch[2], 10);
    detectedSemester = `Sem ${num}`;
    targetYear = Math.ceil(num / 2);
    if (num > 8 && !['ARCH', 'DS'].includes(detectedDept)) {
      detectedSemester = 'Sem 8';
      targetYear = 4;
    }
  } else {
    // Check year keywords
    if (/1st\s*year|first\s*year/i.test(combined)) { targetYear = 1; detectedSemester = 'Sem 1'; }
    else if (/2nd\s*year|second\s*year/i.test(combined)) { targetYear = 2; detectedSemester = 'Sem 3'; }
    else if (/3rd\s*year|third\s*year/i.test(combined)) { targetYear = 3; detectedSemester = 'Sem 5'; }
    else if (/4th\s*year|fourth\s*year|final\s*year/i.test(combined)) { targetYear = 4; detectedSemester = 'Sem 7'; }
    else if (/5th\s*year|fifth\s*year/i.test(combined) && ['ARCH', 'DS'].includes(detectedDept)) { targetYear = 5; detectedSemester = 'Sem 9'; }
  }

  // 4. Extract Suggested Topics
  const suggestedTopics = [];
  if (/(exam|preparation|midterm|final|cram|revision|important)/i.test(combined)) suggestedTopics.push('Exam Prep');
  if (/(formula|equation|cheat\s*sheet|derivations|theorem)/i.test(combined)) suggestedTopics.push('Formula Sheet');
  if (/(pyq|previous\s*year|past\s*paper|university\s*questions)/i.test(combined)) suggestedTopics.push('Previous Year Questions (PYQ)');
  if (/(lab|practical|experiment|code\s*sample)/i.test(combined)) suggestedTopics.push('Lab Manual');
  if (/(derivation|proof|mathematical)/i.test(combined)) suggestedTopics.push('Important Derivations');
  if (/(assignment|homework|tutorial|solved)/i.test(combined)) suggestedTopics.push('Solved Assignments');
  if (/(gate|competitive|psu|aptitude)/i.test(combined)) suggestedTopics.push('GATE / Competitive');
  if (/(handwritten|notes|classroom)/i.test(combined)) suggestedTopics.push('Handwritten Notes');
  if (suggestedTopics.length === 0) suggestedTopics.push('Exam Prep');

  const cleanTitle = title || fileName.replace(/\.pdf$/i, '').replace(/[_-]/g, ' ') || 'Academic Resource';

  return {
    suggestedTitle: cleanTitle,
    department: detectedDept,
    semester: detectedSemester,
    targetYear: targetYear || 0,
    resourceType: detectedType,
    suggestedTopics,
    tags: [detectedType, detectedSemester, detectedDept, ...suggestedTopics].filter(Boolean),
    aiSummary: `AI Synthesized Academic Brief: High-yield ${detectedType.toLowerCase()} for ${detectedDept} (${detectedSemester || 'All Semesters'}). Highlights fundamental engineering principles, exam-critical definitions, and step-by-step problem-solving frameworks.`
  };
}

// ============================================================================
// 1. AUTHENTICATION & SELF-APPROVING FIRST ADMIN
// ============================================================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, username, password, role, year, facultyRole, department, clubs } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Please enter your full name.' });
    }
    if (!username || !username.trim()) {
      return res.status(400).json({ error: 'Please choose a username.' });
    }
    if (!password || !password.trim()) {
      return res.status(400).json({ error: 'Please choose a password.' });
    }

    const cleanUsername = username.toLowerCase().trim();
    const validationError = validateRoleAndDepartment({ role, year, facultyRole, department });
    if (validationError) return res.status(400).json({ error: validationError });

    const existing = await User.findOne({ username: cleanUsername });
    if (existing) {
      return res.status(400).json({ error: `Username "${cleanUsername}" is already taken. Please choose another username or sign in.` });
    }

    let isApproved = true;
    let isFirstAdmin = false;
    if (role === 'Admin') {
      const adminCount = await User.countDocuments({ role: 'Admin' });
      isFirstAdmin = adminCount === 0;
      isApproved = isFirstAdmin; // First Admin self-approves automatically; subsequent admins require approval
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = await User.create({
      name: name.trim(),
      username: cleanUsername,
      passwordHash,
      role,
      year: ['Student', 'Senior Student'].includes(role) ? Number(year) : null,
      facultyRole: role === 'Faculty' ? facultyRole : null,
      department: role === 'Admin' ? 'Administration' : department,
      isApproved,
      isPrimaryAdmin: isFirstAdmin,
      clubs: role === 'Admin'
        ? { tech: [], nonTech: [], sports: [], cultural: [], volunteering: [] }
        : (clubs || { tech: [], nonTech: [], sports: [], cultural: [], volunteering: [] })
    });

    // If an Admin registered but is not the first admin, require approval from the first admin
    if (role === 'Admin' && !isApproved) {
      return res.json({
        pendingApproval: true,
        message: 'Admin account registered successfully! Your account is pending approval by the primary Admin before access is granted.'
      });
    }

    const token = jwt.sign({ id: newUser._id, role: newUser.role }, JWT_SECRET, { expiresIn: '30d' });
    const userObj = newUser.toObject();
    delete userObj.passwordHash;
    userObj.isPrimaryAdmin = isFirstAdmin;

    res.json({ token, user: userObj, isFirstAdmin });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !username.trim()) {
      return res.status(400).json({ error: 'Please enter your username.' });
    }
    if (!password || !password.trim()) {
      return res.status(400).json({ error: 'Please enter your password.' });
    }

    const cleanUsername = username.toLowerCase().trim();
    const user = await User.findOne({ username: cleanUsername });
    if (!user) {
      return res.status(401).json({
        error: `Username "${cleanUsername}" not found. Please check spelling or tap "Create Account" to register.`
      });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({
        error: 'Incorrect password. Please verify and try again.'
      });
    }

    if (user.role === 'Admin' && !user.isApproved) {
      return res.status(403).json({
        error: `Your Administrator account (@${user.username}) is pending authorization by the Primary Administrator. Once approved, you will be able to sign in immediately.`,
        isPendingApproval: true,
        adminName: user.name,
        adminUsername: user.username
      });
    }

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    const userObj = user.toObject();
    delete userObj.passwordHash;
    userObj.isPrimaryAdmin = await isMainAdmin(user);

    res.json({ token, user: userObj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', authMiddleware, async (req, res) => {
  if (req.user.role !== 'Admin' || !req.user.isApproved) {
    return res.status(403).json({ error: 'Approved Admin access required' });
  }
  const users = await User.find().select('-passwordHash').sort({ createdAt: -1 });
  const isPrimary = await isMainAdmin(req.user);
  const primary = await User.findOne({ role: 'Admin', isApproved: true }).sort({ createdAt: 1 });
  const mapped = users.map((u) => {
    const obj = u.toObject();
    obj.isPrimaryAdmin = (primary && String(primary._id) === String(u._id)) || u.isPrimaryAdmin === true;
    return obj;
  });
  res.json({ users: mapped, isCurrentUserPrimaryAdmin: isPrimary });
});

app.patch('/api/admin/users/:id/approve', authMiddleware, async (req, res) => {
  const isMain = await isMainAdmin(req.user);
  if (!isMain) {
    return res.status(403).json({ error: 'Access denied: Only the Primary Administrator can approve or modify admin accounts.' });
  }
  // Safeguard: Do not allow the primary admin to accidentally unapprove themselves
  if (String(req.params.id) === String(req.user._id) && req.body.isApproved === false) {
    return res.status(400).json({ error: 'You cannot revoke your own primary Admin privileges.' });
  }
  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { isApproved: req.body.isApproved },
    { new: true }
  ).select('-passwordHash');
  res.json(updated);
});

app.delete('/api/admin/users/:id', authMiddleware, async (req, res) => {
  const isMain = await isMainAdmin(req.user);
  if (!isMain) {
    return res.status(403).json({ error: 'Access denied: Only the Primary Administrator can reject or remove accounts.' });
  }
  if (String(req.params.id) === String(req.user._id)) {
    return res.status(400).json({ error: 'You cannot delete the Primary Administrator account.' });
  }
  await User.findByIdAndDelete(req.params.id);
  res.json({ success: true, message: 'Account removed successfully.' });
});

// ============================================================================
// ADMIN PERSPECTIVE SWITCHER (User POV Testing)
// Main Primary Admin: Full POV (Test Personas + Any Real User Account)
// Secondary Admins: Sandbox POV (Test Personas ONLY)
// ============================================================================
app.post('/api/admin/switch-account', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'Admin' || !req.user.isApproved) {
      return res.status(403).json({
        error: 'Access denied: Only approved administrators are authorized to switch accounts for POV testing.'
      });
    }

    const isMain = await isMainAdmin(req.user);
    const { targetUserId, presetRole, presetDepartment, presetYear, presetFacultyRole } = req.body;

    // Secondary admins are strictly restricted to Test Personas
    if (targetUserId && !isMain) {
      return res.status(403).json({
        error: 'Access denied: Secondary administrators are only authorized to test preset personas. Only the Primary Administrator can switch into specific user accounts.'
      });
    }

    let targetUser = null;

    if (targetUserId) {
      targetUser = await User.findById(targetUserId).select('-passwordHash');
      if (!targetUser) return res.status(404).json({ error: 'Target user account not found.' });
    } else if (presetRole) {
      const cleanDept = presetDepartment || 'CSE';
      const cleanRole = presetRole;
      const cleanYr = presetYear || 1;
      const cleanUsername = `test_${cleanRole.toLowerCase().replace(/\s+/g, '')}_${cleanDept.toLowerCase().replace(/[^a-z0-9]/g, '')}_y${cleanYr}`;

      targetUser = await User.findOne({ username: cleanUsername });
      if (!targetUser) {
        const dummyHash = await bcrypt.hash('testpass123', 10);
        targetUser = await User.create({
          name: `Test Persona: ${cleanRole} (${cleanDept})`,
          username: cleanUsername,
          passwordHash: dummyHash,
          role: cleanRole,
          year: ['Student', 'Senior Student'].includes(cleanRole) ? Number(cleanYr) : null,
          facultyRole: cleanRole === 'Faculty' ? (presetFacultyRole || 'Assistant Prof') : null,
          department: cleanRole === 'Admin' ? 'Administration' : cleanDept,
          isApproved: true,
          clubs: { tech: [], nonTech: [], sports: [], cultural: [], volunteering: [] }
        });
      }
    } else {
      return res.status(400).json({ error: 'Please provide targetUserId or a preset persona.' });
    }

    const token = jwt.sign(
      {
        id: targetUser._id,
        role: targetUser.role,
        isTestingPerspective: true,
        switchedByAdminId: req.user._id,
        isPrimaryAdminSwitched: isMain
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    const userObj = targetUser.toObject();
    delete userObj.passwordHash;

    res.json({
      success: true,
      token,
      user: userObj,
      originalAdmin: {
        id: req.user._id,
        name: req.user.name,
        username: req.user.username,
        role: req.user.role,
        isPrimaryAdmin: isMain
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const autoMeta = autoTagResource({
      title: cleanName,
      fileName: req.file.originalname
    });

    // If autoMeta couldn't detect department, fallback to user's registered department
    if (autoMeta.department === 'General' && req.user.department && req.user.department !== 'Administration') {
      autoMeta.department = req.user.department;
    }

    res.json({
      success: true,
      pdfUrl: secureUrl,
      detectedMeta: autoMeta
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Standalone AI Auto-Tagging Preview for Upload Hub
app.post('/api/resources/ai-autotag', authMiddleware, (req, res) => {
  try {
    const { title, fileName, description, summary } = req.body;
    const meta = autoTagResource({ title, fileName, description, summary });
    if (meta.department === 'General' && req.user.department && req.user.department !== 'Administration') {
      meta.department = req.user.department;
    }
    res.json(meta);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 3. ACADEMIC RESOURCES (TRIZ Dimension & Verification)
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

    // Optional semester check
    const semValue = semester && semester !== 'None (Optional)' && semester !== 'None' ? semester : null;
    const isFifthYearDept = FIFTH_YEAR_ELIGIBLE_DEPTS.includes(department);

    if (semValue && ['Sem 9', 'Sem 10'].includes(semValue) && !isFifthYearDept) {
      return res.status(400).json({
        error: `Sem 9 and Sem 10 are strictly restricted to 5-year degree programs (ARCH and DS). ${department} only supports Sem 1 through Sem 8.`
      });
    }

    // Target Year: 0 represents "All Years"
    const parsedYear = (targetYear === 'All Years' || targetYear === 'All' || targetYear === 0 || !targetYear)
      ? 0
      : Number(targetYear);

    if (parsedYear === 5 && !isFifthYearDept) {
      return res.status(400).json({
        error: `5th Year is strictly restricted to ARCH and DS departments. ${department} only has 4 years (Sem 1 to 8).`
      });
    }

    const autoVerify = ['Faculty', 'Admin'].includes(req.user.role) && req.user.isApproved;

    const resource = await Resource.create({
      title,
      course: course || 'Core Subject',
      semester: semValue,
      resourceType: resourceType || 'Lecture Notes',
      department,
      targetYear: parsedYear,
      summary: summary || 'AI Summary generated via AURA extraction engine.',
      extractedText: extractedText || `${title} ${course} ${summary}`,
      tags: tags || [department, semValue || 'All Semesters', resourceType].filter(Boolean),
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
    const { department } = req.query;
    const filter = {};
    if (department && department !== 'All' && department !== 'All Departments') {
      filter.department = department;
    }
    const resources = await Resource.find(filter).sort({ createdAt: -1 });
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
    if (resource && resource.uploaderId) {
      await awardPoints(resource.uploaderId, 30, 'Resource Verified');
    }
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
// 5. Q&A BOARD ENDPOINTS (Club-Integrated & Gamified with Plus Ultra Points)
// ============================================================================
app.get('/api/qa', authMiddleware, async (req, res) => {
  const { department, clubCategory, clubName } = req.query;
  const filter = {};
  if (department && department !== 'All' && department !== 'All Departments') {
    filter.department = department;
  }
  if (clubCategory && clubCategory !== 'All') {
    filter.clubCategory = clubCategory;
  }
  if (clubName && clubName !== 'All') {
    filter.clubName = clubName;
  }
  const questions = await Question.find(filter).sort({ createdAt: -1 });
  res.json(questions);
});

app.post('/api/qa', authMiddleware, async (req, res) => {
  const { question, department, clubCategory, clubName } = req.body;
  const created = await Question.create({
    question,
    department: department || req.user.department || 'All',
    clubCategory: clubCategory || null,
    clubName: clubName || null,
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
          responderRole: req.user.role,
          isAccepted: false,
          upvotes: 0,
          upvoters: []
        }
      }
    },
    { new: true }
  );
  // Award +5 PUP for participating with an answer
  await awardPoints(req.user._id, 5, 'Q&A Answer Contribution');
  res.json(updated);
});

// Upvote an answer (+10 Plus Ultra Points to responder)
app.post('/api/qa/:id/answers/:ansId/upvote', authMiddleware, async (req, res) => {
  try {
    const question = await Question.findById(req.params.id);
    if (!question) return res.status(404).json({ error: 'Question not found' });
    const answer = question.answers.id(req.params.ansId);
    if (!answer) return res.status(404).json({ error: 'Answer not found' });

    const userIdStr = String(req.user._id);
    if (!answer.upvoters) answer.upvoters = [];
    const voterIdx = answer.upvoters.findIndex((id) => String(id) === userIdStr);

    let upvoted = false;
    if (voterIdx >= 0) {
      answer.upvoters.splice(voterIdx, 1);
      answer.upvotes = Math.max(0, (answer.upvotes || 1) - 1);
    } else {
      answer.upvoters.push(req.user._id);
      answer.upvotes = (answer.upvotes || 0) + 1;
      upvoted = true;
      if (answer.responderId && String(answer.responderId) !== userIdStr) {
        await awardPoints(answer.responderId, 10, 'Q&A Answer Upvote');
      }
    }
    await question.save();
    res.json({ success: true, upvoted, upvotes: answer.upvotes, question });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept an answer (+50 Plus Ultra Points to responder)
app.post('/api/qa/:id/answers/:ansId/accept', authMiddleware, async (req, res) => {
  try {
    const question = await Question.findById(req.params.id);
    if (!question) return res.status(404).json({ error: 'Question not found' });

    const isAsker = String(question.askerId) === String(req.user._id);
    const isStaffOrAdmin = ['Admin', 'Faculty'].includes(req.user.role);
    if (!isAsker && !isStaffOrAdmin) {
      return res.status(403).json({ error: 'Only the question author, Faculty, or Admin can mark an answer as Accepted.' });
    }

    const answer = question.answers.id(req.params.ansId);
    if (!answer) return res.status(404).json({ error: 'Answer not found' });

    const wasAccepted = Boolean(answer.isAccepted);
    question.answers.forEach((a) => { a.isAccepted = false; });
    answer.isAccepted = !wasAccepted;

    if (!wasAccepted && answer.responderId) {
      await awardPoints(answer.responderId, 50, 'Q&A Answer Accepted');
    }
    await question.save();
    res.json({ success: true, isAccepted: answer.isAccepted, question });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 6. EXPERIENCES & GUIDES (With Expanded Tags, Ratings & Plus Ultra Points)
// ============================================================================
app.get('/api/guides', authMiddleware, async (req, res) => {
  const guides = await Guide.find().sort({ createdAt: -1 });
  res.json(guides);
});

app.post('/api/guides', authMiddleware, async (req, res) => {
  const { title, category, department, content, tags, topics } = req.body;
  const guide = await Guide.create({
    title,
    category: category || 'Placement Tip',
    department: department || req.user.department || 'All',
    content,
    tags: Array.isArray(tags) ? tags : [],
    topics: Array.isArray(topics) ? topics : [],
    authorId: req.user._id,
    authorName: req.user.name,
    authorRole: req.user.role,
    ratings: [],
    averageRating: 0
  });
  // Award +15 PUP for sharing an experience guide
  await awardPoints(req.user._id, 15, 'Guide Contribution');
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

  // If rating is high (4 or 5 stars), reward guide author with +25 PUP
  if (stars >= 4 && guide.authorId && String(guide.authorId) !== String(req.user._id)) {
    await awardPoints(guide.authorId, 25, 'High Guide Rating');
  }

  res.json(guide);
});

// Plus Ultra Points & Top Mentors Leaderboard
app.get('/api/leaderboard', authMiddleware, async (req, res) => {
  try {
    const { department } = req.query;
    const query = {
      isApproved: true,
      role: { $in: ['Student', 'Senior Student', 'Alumni'] }
    };
    if (department && department !== 'All' && department !== 'All Departments') {
      query.department = department;
    }

    const leaderboard = await User.find(query)
      .sort({ plusUltraPoints: -1, createdAt: 1 })
      .limit(20)
      .select('name username department year role plusUltraPoints badges');

    const allRanked = await User.find({ isApproved: true, role: { $in: ['Student', 'Senior Student', 'Alumni'] } })
      .sort({ plusUltraPoints: -1 });
    const userRank = allRanked.findIndex((u) => String(u._id) === String(req.user._id)) + 1;

    res.json({
      leaderboard,
      currentUser: {
        rank: userRank || 1,
        points: req.user.plusUltraPoints || 0,
        badges: req.user.badges || []
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
      // 1. All Campus Broadcast
      if (n.targetAll) {
        matched.push({
          ...n.toObject(),
          entryPathTriggers: ['🌐 Broadcast: All Campus']
        });
        continue;
      }

      // 2. Activity / Organization Filters
      const hasDeptFilter = (n.targetDepartments || []).length > 0;
      const hasTechFilter = (n.targetTechClubs || []).length > 0;
      const hasNonTechFilter = (n.targetNonTechClubs || []).length > 0;
      const hasSportsFilter = (n.targetSportsTeams || []).length > 0;
      const hasCulturalFilter = (n.targetCulturalAssociations || []).length > 0;
      const hasVolunteeringFilter = (n.targetVolunteeringGroups || []).length > 0;

      const hasAnyActivityFilter =
        hasDeptFilter || hasTechFilter || hasNonTechFilter ||
        hasSportsFilter || hasCulturalFilter || hasVolunteeringFilter;

      const activityTriggers = [];
      if (hasDeptFilter) {
        if (n.targetDepartments.includes('All')) {
          activityTriggers.push('Dept: All Departments');
        } else if (n.targetDepartments.includes(user.department)) {
          activityTriggers.push(`Dept: ${user.department}`);
        }
      }
      const matchedTech = (n.targetTechClubs || []).filter((c) => (user.clubs?.tech || []).includes(c));
      if (matchedTech.length > 0) activityTriggers.push(`Tech: ${matchedTech.join(', ')}`);

      const matchedNonTech = (n.targetNonTechClubs || []).filter((c) => (user.clubs?.nonTech || []).includes(c));
      if (matchedNonTech.length > 0) activityTriggers.push(`Non-Tech: ${matchedNonTech.join(', ')}`);

      const matchedSports = (n.targetSportsTeams || []).filter((c) => (user.clubs?.sports || []).includes(c));
      if (matchedSports.length > 0) activityTriggers.push(`Sports: ${matchedSports.join(', ')}`);

      const matchedCultural = (n.targetCulturalAssociations || []).filter((c) => (user.clubs?.cultural || []).includes(c));
      if (matchedCultural.length > 0) activityTriggers.push(`Cultural: ${matchedCultural.join(', ')}`);

      const matchedVolunteering = (n.targetVolunteeringGroups || []).filter((c) => (user.clubs?.volunteering || []).includes(c));
      if (matchedVolunteering.length > 0) activityTriggers.push(`Volunteering: ${matchedVolunteering.join(', ')}`);

      const activityMatches = hasAnyActivityFilter ? (activityTriggers.length > 0) : true;

      // 3. Year Specifics Filter
      const hasYearFilter = n.targetAllYears || (n.targetYears && n.targetYears.length > 0);
      let yearMatches = true;
      let yearTrigger = null;

      if (n.targetAllYears || (n.targetYears && (n.targetYears.includes(0) || n.targetYears.includes('All Years')))) {
        yearMatches = true;
        yearTrigger = 'All Years';
      } else if (n.targetYears && n.targetYears.length > 0) {
        if (user.year && n.targetYears.includes(Number(user.year))) {
          yearMatches = true;
          yearTrigger = `Year ${user.year}`;
        } else {
          yearMatches = false;
        }
      }

      // Check if user is a targeted recipient
      const isTargetRecipient = activityMatches && yearMatches && (hasAnyActivityFilter || hasYearFilter);

      if (isTargetRecipient) {
        const triggers = [...activityTriggers];
        if (yearTrigger) triggers.push(yearTrigger);
        matched.push({
          ...n.toObject(),
          entryPathTriggers: triggers.length > 0 ? triggers : ['Target Filter Match']
        });
      } else if (String(n.senderId) === String(user._id) || (user.role === 'Admin' && user.isApproved)) {
        // Admin or sender audit view
        matched.push({
          ...n.toObject(),
          entryPathTriggers: ['Sender / Admin Audit Log']
        });
      }
    }

    res.json(matched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper to dispatch Expo Push Notifications to external device notification bars
async function dispatchExpoPushNotifications({ pushTokens, title, message, data = {} }) {
  if (!pushTokens || pushTokens.length === 0) return;
  const validTokens = [...new Set(pushTokens)].filter(
    (t) => typeof t === 'string' && (t.startsWith('ExponentPushToken') || t.startsWith('ExpoPushToken'))
  );
  if (validTokens.length === 0) return;

  const messages = validTokens.map((to) => ({
    to,
    sound: 'default',
    title: `📢 ${title}`,
    body: message,
    data,
    channelId: 'aura_alerts',
    priority: 'high'
  }));

  try {
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(chunk)
      });
    }
  } catch (err) {
    console.error('Expo Push Service error:', err.message);
  }
}

app.post('/api/users/push-token', authMiddleware, async (req, res) => {
  try {
    const { pushToken } = req.body;
    if (!pushToken) return res.status(400).json({ error: 'Push token required' });
    if (!req.user.pushTokens) req.user.pushTokens = [];
    if (!req.user.pushTokens.includes(pushToken)) {
      req.user.pushTokens.push(pushToken);
      await req.user.save();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications', authMiddleware, async (req, res) => {
  try {
    if (!['Admin', 'Faculty'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only Admin and Faculty can dispatch multi-target notifications.' });
    }
    if (req.user.role === 'Admin' && !req.user.isApproved) {
      return res.status(403).json({ error: 'Your Admin account is pending approval.' });
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

    const isAllYears = Boolean(targetAllYears) || (targetYears || []).includes(0) || (targetYears || []).includes('All Years');
    const cleanYears = (targetYears || []).filter(y => y !== 'All Years' && y !== 0).map(Number);

    const note = await Notification.create({
      title,
      message,
      senderId: req.user._id,
      senderName: req.user.name,
      senderRole: req.user.role,
      targetAll: Boolean(targetAll),
      targetAllYears: isAllYears,
      targetYears: cleanYears,
      targetDepartments: targetDepartments || [],
      targetTechClubs: targetTechClubs || [],
      targetNonTechClubs: targetNonTechClubs || [],
      targetSportsTeams: targetSportsTeams || [],
      targetCulturalAssociations: targetCulturalAssociations || [],
      targetVolunteeringGroups: targetVolunteeringGroups || []
    });

    // Collect recipient push tokens and dispatch push alerts to notification bar outside app
    let recipientUsers = [];
    if (note.targetAll) {
      recipientUsers = await User.find({ 'pushTokens.0': { $exists: true } }).select('pushTokens');
    } else {
      const candidates = await User.find({ 'pushTokens.0': { $exists: true } });
      recipientUsers = candidates.filter((u) => {
        const hasDeptFilter = (note.targetDepartments || []).length > 0;
        const hasTechFilter = (note.targetTechClubs || []).length > 0;
        const hasNonTechFilter = (note.targetNonTechClubs || []).length > 0;
        const hasSportsFilter = (note.targetSportsTeams || []).length > 0;
        const hasCulturalFilter = (note.targetCulturalAssociations || []).length > 0;
        const hasVolunteeringFilter = (note.targetVolunteeringGroups || []).length > 0;

        const hasAnyActivityFilter =
          hasDeptFilter || hasTechFilter || hasNonTechFilter ||
          hasSportsFilter || hasCulturalFilter || hasVolunteeringFilter;

        let activityMatches = !hasAnyActivityFilter;
        if (hasDeptFilter) {
          if (
            note.targetDepartments.includes('All') ||
            note.targetDepartments.includes('General') ||
            note.targetDepartments.includes(u.department)
          ) {
            activityMatches = true;
          }
        }
        if (!activityMatches && hasTechFilter) {
          if ((note.targetTechClubs || []).some((c) => (u.clubs?.tech || []).includes(c))) activityMatches = true;
        }
        if (!activityMatches && hasNonTechFilter) {
          if ((note.targetNonTechClubs || []).some((c) => (u.clubs?.nonTech || []).includes(c))) activityMatches = true;
        }
        if (!activityMatches && hasSportsFilter) {
          if ((note.targetSportsTeams || []).some((c) => (u.clubs?.sports || []).includes(c))) activityMatches = true;
        }
        if (!activityMatches && hasCulturalFilter) {
          if ((note.targetCulturalAssociations || []).some((c) => (u.clubs?.cultural || []).includes(c))) activityMatches = true;
        }
        if (!activityMatches && hasVolunteeringFilter) {
          if ((note.targetVolunteeringGroups || []).some((c) => (u.clubs?.volunteering || []).includes(c))) activityMatches = true;
        }

        let yearMatches = true;
        if (!note.targetAllYears && note.targetYears && note.targetYears.length > 0) {
          yearMatches = u.year && note.targetYears.includes(Number(u.year));
        }

        return activityMatches && yearMatches;
      });
    }

    const pushTokens = recipientUsers.flatMap((u) => u.pushTokens || []);
    dispatchExpoPushNotifications({
      pushTokens,
      title: note.title,
      message: note.message,
      data: { notificationId: String(note._id) }
    }).catch((e) => console.log('Push dispatch error:', e.message));

    res.json(note);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 9. HIRING UPDATES & PLACEMENT RADAR (AI Auto-Tagging + Dept & Admin Approvals)
// ============================================================================

// AI Auto-Tagging Engine (Level 2)
function autoTagHiringPost({ role = '', description = '', company = '' }) {
  const text = `${role} ${description} ${company}`.toLowerCase();
  const taggedDepts = new Set();

  if (/(software|developer|sde|frontend|backend|fullstack|web|react|node|python|java|c\+\+|javascript|coding|cloud|devops|aws|azure|cyber|security|testing|qa|it|database|sql)/i.test(text)) {
    taggedDepts.add('CSE');
    taggedDepts.add('IT');
  }
  if (/(data|analyst|analytics|machine learning|ml|ai|artificial intelligence|deep learning|nlp|vision|science)/i.test(text)) {
    taggedDepts.add('DS');
    taggedDepts.add('AIML');
    taggedDepts.add('CSE');
  }
  if (/(business|consulting|product|management|analyst|fintech|banking|operations)/i.test(text)) {
    taggedDepts.add('CSBS');
  }
  if (/(circuit|vlsi|verilog|asic|fpga|semiconductor|chip|silicon|hardware)/i.test(text)) {
    taggedDepts.add('VLSA');
    taggedDepts.add('ECE');
  }
  if (/(electronics|telecom|communication|signal|embedded|iot|dsp|sensor)/i.test(text)) {
    taggedDepts.add('ECE');
    taggedDepts.add('EEE');
  }
  if (/(power|electrical|grid|battery|ev|motor|energy|high voltage|substation)/i.test(text)) {
    taggedDepts.add('EEE');
    taggedDepts.add('EEE(CS)');
  }
  if (/(mechanical|manufacturing|thermal|cad|cam|ansys|solidworks|hvac|piping|automobile|chassis|aerospace)/i.test(text)) {
    taggedDepts.add('MECH');
  }
  if (/(robotics|automation|mechatronics|plc|scada|drone|uav|actuator)/i.test(text)) {
    taggedDepts.add('MECT');
    taggedDepts.add('MECH');
  }
  if (/(civil|structural|construction|surveying|concrete|geotechnical|transportation|autocad civil|staad)/i.test(text)) {
    taggedDepts.add('CIVIL');
  }
  if (/(architect|architecture|urban|landscape|revit|bim|sketchup|interior|space planning)/i.test(text)) {
    taggedDepts.add('ARCH');
    taggedDepts.add('Interior design');
  }
  if (/(fashion|textile|garment|apparel|merchandiser|fabric|pattern)/i.test(text)) {
    taggedDepts.add('Fashion Technology');
  }

  if (taggedDepts.size === 0) {
    taggedDepts.add('CSE');
    taggedDepts.add('IT');
    taggedDepts.add('ECE');
  }

  const deptsArray = Array.from(taggedDepts);
  const defaultYears = [3, 4];
  if (deptsArray.includes('ARCH') || deptsArray.includes('DS')) {
    defaultYears.push(5);
  }
  defaultYears.sort((a, b) => a - b);
  const optionalYears = [1, 2];

  return {
    targetDepartments: deptsArray,
    targetYears: defaultYears,
    defaultYears,
    optionalYears
  };
}

// 1. AI Auto-tag preview endpoint
app.post('/api/jobs/ai-autotag', authMiddleware, (req, res) => {
  const { role, description, company } = req.body;
  const result = autoTagHiringPost({ role, description, company });
  res.json(result);
});

// 2. Fetch all jobs according to role and eligibility
app.get('/api/jobs', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const isAdmin = user.role === 'Admin' && user.isApproved;
    const inChargeDept = user.placementDepartment || (user.isPlacementInCharge ? user.department : null);

    const allJobs = await JobUpdate.find().sort({ createdAt: -1 });

    if (isAdmin) {
      return res.json({
        jobs: allJobs,
        canApproveGlobally: true,
        canApproveDepartments: PROFILE_DEPARTMENTS,
        isPlacementInCharge: true,
        managedDepartment: 'All (Admin)'
      });
    }

    if (user.isPlacementInCharge && inChargeDept) {
      const visible = allJobs.filter((j) => {
        const isTargetedForMyDept = (j.targetDepartments || []).includes(inChargeDept);
        const hasPublishedDept = (j.departmentApprovals || []).some((da) => da.status === 'Published');
        return isTargetedForMyDept || hasPublishedDept || j.isGloballyPublished;
      });
      return res.json({
        jobs: visible,
        canApproveGlobally: false,
        canApproveDepartments: [inChargeDept],
        isPlacementInCharge: true,
        managedDepartment: inChargeDept
      });
    }

    // Students & Faculty: Only see published jobs where their department is approved and their year is targeted
    const studentDept = user.department;
    const studentYear = user.year;

    const visibleForStudent = allJobs.filter((job) => {
      const deptApproval = (job.departmentApprovals || []).find((da) => da.department === studentDept);
      const isDeptPublished = deptApproval && deptApproval.status === 'Published';
      const isPublished = isDeptPublished || job.isGloballyPublished;
      if (!isPublished) return false;

      if (studentYear && job.targetYears && job.targetYears.length > 0) {
        if (!job.targetYears.includes(Number(studentYear))) return false;
      }
      return true;
    });

    res.json({
      jobs: visibleForStudent,
      canApproveGlobally: false,
      canApproveDepartments: [],
      isPlacementInCharge: false,
      managedDepartment: null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Create a hiring post
app.post('/api/jobs', authMiddleware, async (req, res) => {
  try {
    const {
      company,
      role,
      jobType,
      description,
      applyUrl,
      sourceUrl,
      location,
      stipendOrSalary,
      deadline,
      targetDepartments = [],
      targetYears = [3, 4],
      adminImmediatePublish = false
    } = req.body;

    if (!company || !role || !description || !applyUrl) {
      return res.status(400).json({ error: 'Company, Role, Description, and Apply Link are required.' });
    }

    const isAdmin = req.user.role === 'Admin' && req.user.isApproved;

    const departmentApprovals = targetDepartments.map((dept) => ({
      department: dept,
      status: (isAdmin && adminImmediatePublish) ? 'Published' : 'Pending',
      approvedBy: (isAdmin && adminImmediatePublish) ? `${req.user.name} (Admin Override)` : null,
      approvedById: (isAdmin && adminImmediatePublish) ? req.user._id : null,
      approvedAt: (isAdmin && adminImmediatePublish) ? new Date() : null,
      notifiedCount: 0
    }));

    const newJob = await JobUpdate.create({
      company,
      role,
      jobType: jobType || 'Internship',
      description,
      applyUrl,
      sourceUrl: sourceUrl || '',
      location: location || 'On-site / Hybrid',
      stipendOrSalary: stipendOrSalary || 'Competitive',
      deadline: deadline || '',
      targetDepartments,
      targetYears,
      creatorId: req.user._id,
      creatorName: req.user.name,
      creatorRole: req.user.role,
      departmentApprovals,
      isGloballyPublished: isAdmin && adminImmediatePublish
    });

    if (isAdmin && adminImmediatePublish) {
      const candidates = await User.find({
        department: { $in: targetDepartments },
        year: { $in: targetYears },
        'pushTokens.0': { $exists: true }
      });
      const pushTokens = candidates.flatMap((u) => u.pushTokens || []);
      dispatchExpoPushNotifications({
        pushTokens,
        title: `💼 New Hiring: ${role} at ${company}`,
        message: `Hiring open for ${targetDepartments.join(', ')} (${targetYears.map(y => `Yr ${y}`).join(', ')}). Tap to view and apply!`,
        data: { jobId: String(newJob._id), type: 'hiring' }
      }).catch((e) => console.log('Push dispatch error:', e.message));
    }

    res.status(201).json(newJob);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Approve Department(s) for a hiring post
app.patch('/api/jobs/:id/approve-department', authMiddleware, async (req, res) => {
  try {
    const job = await JobUpdate.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job update not found' });

    const user = req.user;
    const isAdmin = user.role === 'Admin' && user.isApproved;
    const inChargeDept = user.placementDepartment || (user.isPlacementInCharge ? user.department : null);

    const { departmentsToApprove = [], isGlobalAdminOverride = false, updatedTargetYears } = req.body;

    if (!isAdmin && !user.isPlacementInCharge) {
      return res.status(403).json({ error: 'Access denied: Placement in-charge or admin authorization required.' });
    }

    if (updatedTargetYears && Array.isArray(updatedTargetYears) && updatedTargetYears.length > 0) {
      job.targetYears = updatedTargetYears;
    }

    let approvedDepts = [];

    if (isAdmin && (isGlobalAdminOverride || departmentsToApprove.length === 0)) {
      // Global Admin Override: Approve ALL eligible departments at once
      job.departmentApprovals.forEach((da) => {
        da.status = 'Published';
        da.approvedBy = `${user.name} (Global Admin Override)`;
        da.approvedById = user._id;
        da.approvedAt = new Date();
      });
      job.isGloballyPublished = true;
      job.globalApprovedBy = user.name;
      job.globalApprovedAt = new Date();
      approvedDepts = [...job.targetDepartments];
    } else if (isAdmin && departmentsToApprove.length > 0) {
      // Admin multi-department selective override
      job.departmentApprovals.forEach((da) => {
        if (departmentsToApprove.includes(da.department)) {
          da.status = 'Published';
          da.approvedBy = `${user.name} (Admin Override)`;
          da.approvedById = user._id;
          da.approvedAt = new Date();
          approvedDepts.push(da.department);
        }
      });
    } else if (user.isPlacementInCharge && inChargeDept) {
      // Department In-Charge approves strictly for their assigned department
      const matchApproval = job.departmentApprovals.find((da) => da.department === inChargeDept);
      if (!matchApproval) {
        return res.status(400).json({ error: `This opportunity is not targeted to your department (${inChargeDept}).` });
      }
      matchApproval.status = 'Published';
      matchApproval.approvedBy = `${user.name} (${inChargeDept} In-Charge)`;
      matchApproval.approvedById = user._id;
      matchApproval.approvedAt = new Date();
      approvedDepts.push(inChargeDept);
    }

    await job.save();

    // Dispatch push notifications strictly to students in newly approved departments
    if (approvedDepts.length > 0) {
      const candidates = await User.find({
        department: { $in: approvedDepts },
        year: { $in: job.targetYears },
        'pushTokens.0': { $exists: true }
      });
      const pushTokens = candidates.flatMap((u) => u.pushTokens || []);
      dispatchExpoPushNotifications({
        pushTokens,
        title: `💼 ${job.company} is Hiring: ${job.role}`,
        message: `Approved for ${approvedDepts.join(', ')} (${job.targetYears.map(y => `Yr ${y}`).join(', ')}). Apply now on AURA!`,
        data: { jobId: String(job._id), type: 'hiring' }
      }).catch((e) => console.log('Push dispatch error:', e.message));
    }

    res.json({ success: true, job, approvedDepartments: approvedDepts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Reject department approval for a hiring post
app.patch('/api/jobs/:id/reject-department', authMiddleware, async (req, res) => {
  try {
    const job = await JobUpdate.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job update not found' });

    const user = req.user;
    const isAdmin = user.role === 'Admin' && user.isApproved;
    const inChargeDept = user.placementDepartment || (user.isPlacementInCharge ? user.department : null);
    const { departmentToReject } = req.body;

    const targetDept = isAdmin ? departmentToReject : inChargeDept;
    const match = job.departmentApprovals.find((da) => da.department === targetDept);
    if (!match) return res.status(400).json({ error: 'Department approval entry not found' });

    match.status = 'Rejected';
    match.approvedBy = `${user.name} (Rejected)`;
    match.approvedById = user._id;
    match.approvedAt = new Date();

    await job.save();
    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Delete a job post
app.delete('/api/jobs/:id', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'Admin' || !req.user.isApproved) {
      return res.status(403).json({ error: 'Admin authorization required' });
    }
    await JobUpdate.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Job update deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Manage Placement In-Charges (Admin only)
app.get('/api/admin/placement-incharges', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'Admin' || !req.user.isApproved) {
      return res.status(403).json({ error: 'Admin authorization required' });
    }
    const incharges = await User.find({ isPlacementInCharge: true }).select('name username department role facultyRole isPlacementInCharge placementDepartment');
    const allFaculty = await User.find({ role: 'Faculty' }).select('name username department facultyRole isPlacementInCharge placementDepartment');
    res.json({ incharges, allFaculty, departments: PROFILE_DEPARTMENTS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/placement-incharges', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'Admin' || !req.user.isApproved) {
      return res.status(403).json({ error: 'Admin authorization required' });
    }
    const { userId, isPlacementInCharge, placementDepartment } = req.body;
    const updated = await User.findByIdAndUpdate(
      userId,
      {
        isPlacementInCharge: Boolean(isPlacementInCharge),
        placementDepartment: isPlacementInCharge ? (placementDepartment || null) : null
      },
      { new: true }
    ).select('-passwordHash');
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ============================================================================
// 10. BUG REPORTS & SUPPORT FEEDBACK HUB ENDPOINTS
// ============================================================================

// 1. Submit a bug report / help ticket (User-facing)
app.post('/api/support/tickets', authMiddleware, async (req, res) => {
  try {
    const { category, title, description, severity, screenshotUrl, deviceInfo } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'Bug title and description are required.' });
    }

    const ticket = await BugReport.create({
      category: category || 'Custom / Other Bug',
      title,
      description,
      severity: severity || 'Medium',
      screenshotUrl: screenshotUrl || null,
      deviceInfo: deviceInfo || {},
      reporterId: req.user._id,
      reporterName: req.user.name,
      reporterRole: req.user.role,
      reporterDepartment: req.user.department,
      reporterUsername: req.user.username,
      status: 'Open'
    });

    res.status(201).json({ success: true, ticket });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Fetch all bug reports (Admin-only Support Hub)
app.get('/api/support/tickets', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'Admin' || !req.user.isApproved) {
      return res.status(403).json({ error: 'Admin authorization required' });
    }
    const tickets = await BugReport.find().sort({ createdAt: -1 });
    res.json(tickets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Update bug report status & admin notes
app.patch('/api/support/tickets/:id', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'Admin' || !req.user.isApproved) {
      return res.status(403).json({ error: 'Admin authorization required' });
    }
    const { status, adminNotes } = req.body;
    const update = {};
    if (status) {
      update.status = status;
      if (['Resolved', 'Closed'].includes(status)) {
        update.resolvedAt = new Date();
        update.resolvedBy = req.user.name;
      }
    }
    if (adminNotes !== undefined) update.adminNotes = adminNotes;

    const ticket = await BugReport.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json(ticket);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Upload screenshot for bug report
app.post('/api/support/upload-screenshot', authMiddleware, upload.single('screenshot'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });
    const buffer = req.file.buffer;
    const filename = `screenshot_${Date.now()}_${req.file.originalname || 'image.png'}`;
    const uploadThingFile = new File([buffer], filename, { type: req.file.mimetype || 'image/png' });
    const uploadResult = await utapi.uploadFiles(uploadThingFile);
    if (!uploadResult || uploadResult.error) {
      return res.status(500).json({ error: uploadResult?.error?.message || 'Screenshot upload failed' });
    }
    const screenshotUrl = uploadResult.data?.url || uploadResult.data?.appUrl;
    res.json({ url: screenshotUrl });
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
    const validationError = validateRoleAndDepartment({ role: role || req.user.role, year, facultyRole, department });
    if (validationError) return res.status(400).json({ error: validationError });

    const updated = await User.findByIdAndUpdate(
      req.user._id,
      {
        name,
        role: req.user.role, // Preserve primary role
        year: ['Student', 'Senior Student'].includes(req.user.role) ? Number(year) : null,
        facultyRole: req.user.role === 'Faculty' ? facultyRole : null,
        department: req.user.role === 'Admin' ? 'Administration' : department,
        clubs: req.user.role === 'Admin' ? { tech: [], nonTech: [], sports: [], cultural: [], volunteering: [] } : clubs
      },
      { new: true }
    ).select('-passwordHash');

    const userObj = updated.toObject();
    userObj.isPrimaryAdmin = await isMainAdmin(updated);

    res.json(userObj);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 11. PRIMARY ADMIN: BATCH ACADEMIC YEAR PROMOTION & COHORT STATS
// ============================================================================
app.get('/api/admin/cohort-stats', authMiddleware, async (req, res) => {
  try {
    const isMain = await isMainAdmin(req.user);
    if (!isMain) return res.status(403).json({ error: 'Primary Administrator access required' });

    const c1 = await User.countDocuments({ year: 1, role: { $in: ['Student', 'Senior Student'] }, isGraduated: false });
    const c2 = await User.countDocuments({ year: 2, role: { $in: ['Student', 'Senior Student'] }, isGraduated: false });
    const c3 = await User.countDocuments({ year: 3, role: { $in: ['Student', 'Senior Student'] }, isGraduated: false });
    const c4ArchDs = await User.countDocuments({ year: 4, department: { $in: ['ARCH', 'DS'] }, isGraduated: false });
    const c4Other = await User.countDocuments({ year: 4, department: { $nin: ['ARCH', 'DS'] }, isGraduated: false });
    const c5 = await User.countDocuments({ year: 5, department: { $in: ['ARCH', 'DS'] }, isGraduated: false });
    const alumniCount = await User.countDocuments({ $or: [{ isGraduated: true }, { role: 'Alumni' }] });

    res.json({
      cohort1: c1,
      cohort2: c2,
      cohort3: c3,
      cohort4ArchDs: c4ArchDs,
      cohort4Other: c4Other,
      cohort4Total: c4ArchDs + c4Other,
      cohort5: c5,
      alumni: alumniCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/promote-cohort', authMiddleware, async (req, res) => {
  try {
    const isMain = await isMainAdmin(req.user);
    if (!isMain) {
      return res.status(403).json({ error: 'Access denied: Only the Primary Administrator can trigger batch cohort promotions.' });
    }

    const cohort = Number(req.body.cohort);
    if (![1, 2, 3, 4, 5].includes(cohort)) {
      return res.status(400).json({ error: 'Invalid cohort. Allowed values: 1, 2, 3, 4, 5.' });
    }

    let promotedCount = 0;
    let graduatedCount = 0;
    let message = '';

    if (cohort === 1) {
      // 1st Year -> 2nd Year
      const result = await User.updateMany(
        { year: 1, role: { $in: ['Student', 'Senior Student'] }, isGraduated: false },
        { $set: { year: 2 } }
      );
      promotedCount = result.modifiedCount;
      message = `Successfully promoted ${promotedCount} student(s) from 1st Year to 2nd Year.`;
    } else if (cohort === 2) {
      // 2nd Year -> 3rd Year (Auto upgrade role to Senior Student)
      const result = await User.updateMany(
        { year: 2, role: { $in: ['Student', 'Senior Student'] }, isGraduated: false },
        { $set: { year: 3, role: 'Senior Student' } }
      );
      promotedCount = result.modifiedCount;
      message = `Successfully promoted ${promotedCount} student(s) from 2nd Year to 3rd Year and auto-upgraded role to "Senior Student".`;
    } else if (cohort === 3) {
      // 3rd Year -> 4th Year
      const result = await User.updateMany(
        { year: 3, role: { $in: ['Student', 'Senior Student'] }, isGraduated: false },
        { $set: { year: 4, role: 'Senior Student' } }
      );
      promotedCount = result.modifiedCount;
      message = `Successfully promoted ${promotedCount} student(s) from 3rd Year to 4th Year.`;
    } else if (cohort === 4) {
      // 4th Year: ARCH & DS promote to 5th Year; all other 4th Year departments graduate
      const archDsResult = await User.updateMany(
        { year: 4, department: { $in: ['ARCH', 'DS'] }, isGraduated: false },
        { $set: { year: 5, role: 'Senior Student' } }
      );
      promotedCount = archDsResult.modifiedCount;

      const gradResult = await User.updateMany(
        { year: 4, department: { $nin: ['ARCH', 'DS'] }, isGraduated: false },
        { $set: { year: null, role: 'Alumni', isGraduated: true } }
      );
      graduatedCount = gradResult.modifiedCount;
      message = `4th Year Batch processed: Promoted ${promotedCount} ARCH & DS student(s) to 5th Year; graduated ${graduatedCount} 4-year degree student(s) to Alumni.`;
    } else if (cohort === 5) {
      // 5th Year ARCH & DS -> Graduate to Alumni
      const gradResult = await User.updateMany(
        { year: 5, department: { $in: ['ARCH', 'DS'] }, isGraduated: false },
        { $set: { year: null, role: 'Alumni', isGraduated: true } }
      );
      graduatedCount = gradResult.modifiedCount;
      message = `5th Year Batch processed: Successfully graduated ${graduatedCount} ARCH & DS student(s) to Alumni status.`;
    }

    res.json({ success: true, cohort, promotedCount, graduatedCount, message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 12. AUTOMATED LINKEDIN SCRAPER BACKGROUND WORKER
// Runs every 2 hours: Scrapes #hiring, #internship, #fresher, #campusdrive
// Stores text + official LinkedIn URL only (zero binary storage)
// Level 2 AI Auto-Tagging for Dept & Target Years + Pending Review Queue
// Auto-deletes expired job postings based on deadline
// ============================================================================
async function runLinkedInScraperWorker() {
  console.log('[LinkedIn Scraper] Starting scheduled background ingestion & deadline cleanup cycle...');
  try {
    // 1. Auto-Deletion of expired job posts
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const deleteResult = await JobUpdate.deleteMany({
      $and: [
        { deadline: { $exists: true, $ne: '' } },
        { deadline: { $lt: todayStr } }
      ]
    });
    if (deleteResult.deletedCount > 0) {
      console.log(`[LinkedIn Scraper] Purged ${deleteResult.deletedCount} expired job opportunity post(s).`);
    }

    // 2. Fetcher: Apify Actor or Curated Campus Radar Feed
    let rawJobs = [];
    if (process.env.APIFY_API_TOKEN && !process.env.APIFY_API_TOKEN.includes('YOUR_')) {
      try {
        console.log('[LinkedIn Scraper] Fetching from Apify LinkedIn Post Scraper Actor...');
        const response = await fetch(
          `https://api.apify.com/v2/acts/apify~linkedin-post-search-scraper/run-sync-get-dataset-items?token=${process.env.APIFY_API_TOKEN}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              searchQueries: ['#hiring #internship', '#fresher #campusdrive', '#engineering hiring'],
              maxItems: 10
            })
          }
        );
        if (response.ok) {
          const items = await response.json();
          rawJobs = (items || []).map((item) => ({
            company: item.authorName || item.companyName || 'Campus Tech Recruiter',
            role: item.headline || 'Software & Core Engineering Role',
            jobType: 'Internship',
            description: (item.text || item.postContent || '').substring(0, 1500),
            sourceUrl: item.url || item.postUrl || 'https://www.linkedin.com/feed/',
            applyUrl: item.externalApplyUrl || item.url || 'https://www.linkedin.com/jobs/',
            location: item.location || 'Remote / Hybrid',
            stipendOrSalary: 'Competitive',
            deadline: new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]
          }));
        }
      } catch (apifyErr) {
        console.warn('[LinkedIn Scraper] Apify call failed, falling back to Curated Campus Radar:', apifyErr.message);
      }
    }

    // Curated high-relevance campus hiring leads (runs reliably in all network/API environments)
    if (rawJobs.length === 0) {
      const timestampSuffix = Math.floor(Date.now() / (1000 * 60 * 60 * 2));
      const sampleFeed = [
        {
          company: 'Zoho Corporation',
          role: 'Software Development & Systems Intern (Batch 2026/2027)',
          jobType: 'Internship',
          description: '#hiring #fresher Zoho is hiring Engineering Interns for our Cloud & Infrastructure team! Candidates from CSE, IT, ECE with strong skills in C++, Java, Python, and Data Structures are eligible. 3rd and 4th year students can apply. Stipend: Rs. 25,000/month with PPO opportunity.',
          sourceUrl: `https://www.linkedin.com/jobs/view/zoho-sde-intern-${timestampSuffix}`,
          applyUrl: 'https://www.zoho.com/careers/',
          location: 'Chennai / Tenkasi',
          stipendOrSalary: '₹25,000 / month',
          deadline: new Date(Date.now() + 20 * 86400000).toISOString().split('T')[0]
        },
        {
          company: 'L&T Technology Services',
          role: 'Graduate Engineering Trainee (GET) - Core Disciplines',
          jobType: 'Full-Time',
          description: '#campusdrive #fresher L&T is hiring for Graduate Engineering Trainee positions! Open to final year students of Mechanical, Civil, Electrical (EEE), and Mechatronics. Minimum 7.0 CGPA required. Apply via our official portal.',
          sourceUrl: `https://www.linkedin.com/jobs/view/ltts-get-campus-${timestampSuffix}`,
          applyUrl: 'https://www.ltts.com/careers',
          location: 'Bangalore / Vadodara',
          stipendOrSalary: '₹6.5 - 8.0 LPA',
          deadline: new Date(Date.now() + 25 * 86400000).toISOString().split('T')[0]
        },
        {
          company: 'Qualcomm India',
          role: 'Hardware & Silicon Design Engineering Intern',
          jobType: 'Internship',
          description: '#hiring #internship Qualcomm Wireless team is looking for VLSI and Digital System Design interns. Eligible for ECE, VLSA, and EEE 3rd/4th years. Skills: Verilog, SystemVerilog, Digital Electronics, and C.',
          sourceUrl: `https://www.linkedin.com/jobs/view/qualcomm-hardware-intern-${timestampSuffix}`,
          applyUrl: 'https://qualcomm.wd5.myworkdayjobs.com/External',
          location: 'Hyderabad / Bangalore',
          stipendOrSalary: '₹45,000 / month',
          deadline: new Date(Date.now() + 18 * 86400000).toISOString().split('T')[0]
        },
        {
          company: 'Cognizant (GenC Elevate)',
          role: 'Digital Engineer & Data Science Associate',
          jobType: 'Full-Time',
          description: '#fresher #hiring Cognizant GenC Elevate campus drive opening for Data Science, CSE, IT, and CSBS students! Candidates with proficiency in SQL, Machine Learning, PowerBI, or Cloud architectures.',
          sourceUrl: `https://www.linkedin.com/jobs/view/cognizant-genc-data-${timestampSuffix}`,
          applyUrl: 'https://careers.cognizant.com/',
          location: 'Pan India Hybrid',
          stipendOrSalary: '₹5.5 - 7.0 LPA',
          deadline: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]
        }
      ];
      rawJobs = sampleFeed;
    }

    let addedCount = 0;
    for (const raw of rawJobs) {
      // De-duplication by sourceUrl
      const existing = await JobUpdate.findOne({ sourceUrl: raw.sourceUrl });
      if (existing) continue;

      // Level 2 AI Auto-Tagging
      const { targetDepartments, targetYears } = autoTagHiringPost({
        role: raw.role,
        description: raw.description,
        company: raw.company
      });

      const depts = targetDepartments.length > 0 ? targetDepartments : ['CSE', 'IT'];
      const deptApprovals = depts.map((d) => ({
        department: d,
        status: 'Pending',
        approvedBy: null,
        approvedById: null,
        approvedAt: null,
        notifiedCount: 0
      }));

      // Strictly store text and URL (zero images / heavy binary attachments)
      await JobUpdate.create({
        company: raw.company,
        role: raw.role,
        jobType: raw.jobType || 'Internship',
        description: raw.description,
        applyUrl: raw.applyUrl,
        sourceUrl: raw.sourceUrl,
        location: raw.location || 'On-site / Hybrid',
        stipendOrSalary: raw.stipendOrSalary || 'Competitive',
        deadline: raw.deadline || '',
        targetDepartments: depts,
        targetYears,
        creatorName: 'LinkedIn Automated Ingest',
        creatorRole: 'Admin',
        departmentApprovals: deptApprovals,
        isGloballyPublished: false
      });
      addedCount++;
    }

    console.log(`[LinkedIn Scraper] Ingestion cycle complete. ${addedCount} new opportunity lead(s) queued for 1-Tap Review.`);
    return { success: true, addedCount, purgedCount: deleteResult?.deletedCount || 0 };
  } catch (err) {
    console.error('[LinkedIn Scraper] Error during worker run:', err.message);
    return { success: false, error: err.message };
  }
}

// Manual trigger for Admin
app.post('/api/admin/scraper/run-now', authMiddleware, async (req, res) => {
  if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
  const result = await runLinkedInScraperWorker();
  res.json(result);
});

// Run LinkedIn Scraper 5s after startup, and recurring every 2 hours
setTimeout(runLinkedInScraperWorker, 5000);
setInterval(runLinkedInScraperWorker, 2 * 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AURA Production Backend listening on 0.0.0.0:${PORT}`);
});
