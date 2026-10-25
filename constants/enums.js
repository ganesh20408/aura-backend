// Valid ONLY for Registration & Profile Setup (Strictly excludes "General")
const PROFILE_DEPARTMENTS = [
  'CIVIL', 'MECH', 'CSE', 'IT', 'ECE', 'EEE', 'MECT', 'CSBS',
  'AIML', 'DS', 'VLSA', 'EEE(CS)', 'ARCH', 'Fashion Technology', 'Interior design'
];

// Valid for Uploading & Searching (Includes "General")
const RESOURCE_DEPARTMENTS = ['General', ...PROFILE_DEPARTMENTS];

const ROLES = ['Student', 'Senior Student', 'Faculty', 'Admin'];

const FACULTY_SUBROLES = ['HOD', 'Professor', 'Assistant Prof', 'Lab Tech'];

// Only ARCH and DS allow 5th Year
const FIFTH_YEAR_ELIGIBLE_DEPTS = ['ARCH', 'DS'];

const EXTRACURRICULARS = {
  tech: [
    'AI Consortium', 'Algo Geeks', 'App Dev', 'AR/VR', 'Ascenders', 'Build Club',
    'Coders', 'MechaDroneX', 'EKALAVYA', 'Electronic Hardware', 'HAM', 'Innov CHEM',
    'IoT', 'Kernel', 'Math', 'School Of Thoughts', 'SDG', 'TCE IP Innovators',
    'Tech Explorers', 'Ventura'
  ],
  nonTech: [
    'All About Art', 'Always on Trend', 'Anglophile', 'Cinemates', 'Foreign Language',
    'Happy Hive', 'Literary', 'SADAS Debate', 'SAE', 'Sports & Cultural', 'Vyugam'
  ],
  sports: [
    'Athletics', 'Badminton', 'Ball Badminton', 'Basket Ball', 'Chess', 'Cricket',
    'Football', 'Handball', 'Hockey', 'Judo', 'Kabaddi', 'Kho-Kho', 'Table Tennis',
    'Tennis', 'Volley Ball'
  ],
  cultural: [
    'Andhadhi', 'Anything For Dance', 'Elitz', 'Morpheus', 'Photons',
    'Quizzards', 'Tamil Mandram', 'Tentkotta', 'Varna'
  ],
  volunteering: ['NCC', 'NSS', 'YRC']
};

module.exports = {
  PROFILE_DEPARTMENTS,
  RESOURCE_DEPARTMENTS,
  ROLES,
  FACULTY_SUBROLES,
  FIFTH_YEAR_ELIGIBLE_DEPTS,
  EXTRACURRICULARS
};