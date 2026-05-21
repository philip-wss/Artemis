/**
 * Generate test data for Weaviate global search performance testing.
 *
 * Usage:
 *   node generate-search-data.mjs [serverUrl] [--courses N]
 *
 * Examples:
 *   node generate-search-data.mjs                          # 30 courses on localhost:8080
 *   node generate-search-data.mjs http://localhost:8080 --courses 20
 *   node generate-search-data.mjs https://staging.example.com --courses 40
 *
 * Each course gets:
 *   - 70 exercises (majority programming, plus text, modeling, quiz, file-upload)
 *   - 20 lectures with 5 units each
 *   - 20 FAQs
 *   - 2 exams (1 past, 1 future) with 5 exercise groups x 3 exercises each
 *   - 50 messages per exercise channel
 *   - 1 public channel with 15 messages
 *
 * Content is theme-consistent per course (CS topics). Some dates are in the past,
 * some in the future, to exercise date-based search filters.
 */

import { HttpClient, createMultipartFormData } from './lib/http-client.mjs';
import { authenticate } from './lib/auth.mjs';
import { ALL_COURSES } from './search-data/index.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const serverUrl = args.find(a => !a.startsWith('--')) || 'http://localhost:8080';
const coursesFlag = args.indexOf('--courses');
const NUM_COURSES = coursesFlag !== -1 ? parseInt(args[coursesFlag + 1], 10) : 30;

const ADMIN_USER = 'artemis_admin';
const ADMIN_PASSWORD = 'artemis_admin';

// Target counts per course
const TARGET_EXERCISES = 70;
const TARGET_LECTURES = 20;
const TARGET_LECTURE_UNITS = 5;
const TARGET_FAQS = 20;
const TARGET_CHANNEL_MESSAGES = 15;
const TARGET_EXERCISE_MESSAGES = 50;

// Exercise type distribution for 70 exercises (majority programming)
const EXERCISE_DISTRIBUTION = {
    programming: 40,
    text: 10,
    modeling: 8,
    quiz: 6,
    'file-upload': 6,
};

// Minimal valid PDF for attachment units
const SAMPLE_PDF_BASE64 = `JVBERi0xLjQKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFszIDAgUl0KL0NvdW50IDEKL01lZGlhQm94IFswIDAgNjEyIDc5Ml0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgovUmVzb3VyY2VzIDw8Ci9Gb250IDw8Ci9GMSA0IDAgUgo+Pgo+PgovQ29udGVudHMgNSAwIFIKPj4KZW5kb2JqCjQgMCBvYmoKPDwKL1R5cGUgL0ZvbnQKL1N1YnR5cGUgL1R5cGUxCi9CYXNlRm9udCAvSGVsdmV0aWNhCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9MZW5ndGggNDQKPj4Kc3RyZWFtCkJUCi9GMSAyNCBUZgoxMDAgNzAwIFRkCihTYW1wbGUgRG9jdW1lbnQpIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDE0NyAwMDAwMCBuIAowMDAwMDAwMjc0IDAwMDAwIG4gCjAwMDAwMDAzNTMgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA2Ci9Sb290IDEgMCBSCj4+CnN0YXJ0eHJlZgo0NDgKJSVFT0Y=`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let shortNameCounter = 0;
// 4-char base-36 suffix derived from the current epoch second — changes each run so
// re-running the script does not collide with short names created in a previous run.
// Short names must match ^[a-zA-Z][a-zA-Z0-9]{2,} and stay under 24 chars.
const RUN_SUFFIX = Math.floor(Date.now() / 1000).toString(36).slice(-4);
function uniqueShortName(prefix) {
    return `${prefix}${++shortNameCounter}${RUN_SUFFIX}`;
}

/** Strip characters disallowed by Artemis TITLE_NAME_PATTERN (^[a-zA-Z0-9_\-\s]*) */
function sanitizeProgrammingTitle(title) {
    return title.replace(/[^a-zA-Z0-9_\-\s]/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function daysFromNow(days) {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function pickN(arr, n) {
    const copy = [...arr];
    const result = [];
    for (let i = 0; i < n && copy.length > 0; i++) {
        const idx = Math.floor(Math.random() * copy.length);
        result.push(copy.splice(idx, 1)[0]);
    }
    return result;
}

/** Cycle through an array to fill `count` items */
function fill(arr, count) {
    const result = [];
    for (let i = 0; i < count; i++) {
        result.push(arr[i % arr.length]);
    }
    return result;
}

function generateTempId() {
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function createCourse(client, courseData, courseIndex) {
    // Alternate start dates: some courses started in the past, some recently
    const startOffset = courseIndex % 3 === 0 ? -90 : courseIndex % 3 === 1 ? -30 : -10;
    const endOffset = courseIndex % 4 === 0 ? -5 : 60 + courseIndex; // some courses already ended

    const course = {
        title: `${courseData.title} (${courseData.shortNamePrefix}-${courseIndex + 1})`,
        shortName: uniqueShortName(courseData.shortNamePrefix),
        description: courseData.description,
        startDate: daysFromNow(startOffset),
        endDate: daysFromNow(endOffset),
        courseInformationSharingConfiguration: 'COMMUNICATION_AND_MESSAGING',
        accuracyOfScores: 1,
        timeZone: 'Europe/Berlin',
        maxComplaints: 3,
        maxTeamComplaints: 3,
        maxComplaintTimeDays: 7,
        maxRequestMoreFeedbackTimeDays: 7,
    };
    const { body, contentType } = createMultipartFormData({ course });
    const response = await client.post('/api/core/admin/courses', body, {
        headers: { 'Content-Type': contentType },
        contentType: 'multipart',
    }).catch(e => {
        const detail = typeof e.response?.data === 'string' ? e.response.data : JSON.stringify(e.response?.data);
        throw new Error(`Course creation failed (HTTP ${e.response?.status}): ${detail || e.message}`);
    });
    return response.data;
}

// -- Exercises ----------------------------------------------------------------

async function createProgrammingExercise(client, courseId, data, releasePast) {
    const sn = uniqueShortName('prog');
    const releaseDate = releasePast ? daysFromNow(-Math.floor(Math.random() * 30 + 5)) : daysFromNow(Math.floor(Math.random() * 5));
    const dueDate = releasePast ? daysFromNow(-Math.floor(Math.random() * 3)) : daysFromNow(14 + Math.floor(Math.random() * 14));

    const exercise = {
        type: 'programming',
        title: sanitizeProgrammingTitle(data.title),
        shortName: sn,
        course: { id: courseId },
        programmingLanguage: 'JAVA',
        projectType: 'PLAIN_GRADLE',
        maxPoints: 100,
        assessmentType: 'AUTOMATIC',
        packageName: 'de.tum.cit.aet',
        allowOnlineEditor: true,
        staticCodeAnalysisEnabled: false,
        releaseDate,
        dueDate,
        problemStatement: `# ${data.title}\n\n${data.problemStatement}`,
        buildConfig: {
            buildScript: '#!/usr/bin/env bash\nset -e\nchmod +x ./gradlew && ./gradlew clean test',
            checkoutSolutionRepository: false,
        },
    };
    return (await client.post('/api/programming/programming-exercises/setup', exercise)).data;
}

async function createTextExercise(client, courseId, data, releasePast) {
    const sn = uniqueShortName('txt');
    const releaseDate = releasePast ? daysFromNow(-20) : daysFromNow(2);
    const dueDate = releasePast ? daysFromNow(-3) : daysFromNow(21);
    const exercise = {
        type: 'text',
        title: data.title,
        shortName: sn,
        course: { id: courseId },
        maxPoints: 100,
        assessmentType: 'MANUAL',
        releaseDate,
        dueDate,
        problemStatement: `# ${data.title}\n\n${data.problemStatement}`,
    };
    return (await client.post('/api/text/text-exercises', exercise)).data;
}

async function createModelingExercise(client, courseId, data, releasePast) {
    const sn = uniqueShortName('mod');
    const releaseDate = releasePast ? daysFromNow(-15) : daysFromNow(1);
    const dueDate = releasePast ? daysFromNow(-2) : daysFromNow(14);
    const exercise = {
        type: 'modeling',
        title: data.title,
        shortName: sn,
        course: { id: courseId },
        maxPoints: 100,
        assessmentType: 'MANUAL',
        diagramType: data.diagramType || 'ClassDiagram',
        releaseDate,
        dueDate,
        problemStatement: `# ${data.title}\n\n${data.problemStatement}`,
    };
    return (await client.post('/api/modeling/modeling-exercises', exercise)).data;
}

async function createQuizExercise(client, courseId, data, releasePast) {
    const sn = uniqueShortName('quiz');
    const releaseDate = releasePast ? daysFromNow(-10) : daysFromNow(3);
    const dueDate = releasePast ? daysFromNow(-1) : daysFromNow(17);

    const quizQuestions = (data.questions || []).map(q => ({
        type: 'multiple-choice',
        title: q.title,
        text: q.text,
        points: q.points || 5,
        singleChoice: q.singleChoice !== false,
        scoringType: 'ALL_OR_NOTHING',
        invalid: false,
        randomizeOrder: false,
        answerOptions: (q.answerOptions || []).map(a => ({
            text: a.text,
            isCorrect: !!a.isCorrect,
            invalid: false,
        })),
    }));

    const exercise = {
        type: 'quiz',
        title: data.title,
        shortName: sn,
        course: { id: courseId },
        duration: 600,
        releaseDate,
        dueDate,
        quizQuestions,
        quizMode: 'SYNCHRONIZED',
        mode: 'INDIVIDUAL',
        includedInOverallScore: 'INCLUDED_COMPLETELY',
    };
    const { body, contentType } = createMultipartFormData({ exercise });
    return (await client.post(`/api/quiz/courses/${courseId}/quiz-exercises`, body, {
        headers: { 'Content-Type': contentType },
        contentType: 'multipart',
    })).data;
}

async function createFileUploadExercise(client, courseId, data, releasePast) {
    const sn = uniqueShortName('file');
    const releaseDate = releasePast ? daysFromNow(-25) : daysFromNow(5);
    const dueDate = releasePast ? daysFromNow(-4) : daysFromNow(28);
    const exercise = {
        type: 'file-upload',
        title: data.title,
        shortName: sn,
        course: { id: courseId },
        maxPoints: 100,
        assessmentType: 'MANUAL',
        filePattern: 'pdf,docx,txt',
        releaseDate,
        dueDate,
        problemStatement: `# ${data.title}\n\n${data.problemStatement}`,
    };
    return (await client.post('/api/fileupload/file-upload-exercises', exercise)).data;
}

// -- Lectures -----------------------------------------------------------------

async function createLecture(client, courseId, lectureData, releasePast) {
    const visibleDate = releasePast ? daysFromNow(-30) : daysFromNow(0);
    const lecture = {
        title: lectureData.title,
        description: lectureData.description,
        course: { id: courseId },
        visibleDate,
    };
    return (await client.post('/api/lecture/lectures', lecture)).data;
}

async function createTextUnit(client, lectureId, unit, releasePast) {
    const releaseDate = releasePast ? daysFromNow(-25) : daysFromNow(0);
    const data = {
        type: 'text',
        name: unit.name,
        content: `# ${unit.name}\n\n${unit.content}`,
        lecture: { id: lectureId },
        releaseDate,
    };
    return client.post(`/api/lecture/lectures/${lectureId}/text-units`, data);
}

async function createOnlineUnit(client, lectureId, unit, releasePast) {
    const releaseDate = releasePast ? daysFromNow(-20) : daysFromNow(0);
    const data = {
        type: 'online',
        name: unit.name,
        description: unit.description,
        source: 'https://example.org/' + unit.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        lecture: { id: lectureId },
        releaseDate,
    };
    return client.post(`/api/lecture/lectures/${lectureId}/online-units`, data);
}

async function createAttachmentUnit(client, lectureId, unit, releasePast) {
    const releaseDate = releasePast ? daysFromNow(-15) : daysFromNow(0);
    const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
    const attachmentVideoUnit = { type: 'attachment', lecture: { id: lectureId } };
    const attachment = { name: unit.name, attachmentType: 'FILE', releaseDate, version: 1 };
    const pdfContent = Buffer.from(SAMPLE_PDF_BASE64, 'base64');

    let body = `--${boundary}\r\nContent-Disposition: form-data; name="attachmentVideoUnit"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(attachmentVideoUnit)}\r\n`;
    body += `--${boundary}\r\nContent-Disposition: form-data; name="attachment"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(attachment)}\r\n`;
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="resource.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
    const afterFile = `\r\n--${boundary}--\r\n`;
    const bodyBuffer = Buffer.concat([
        Buffer.from(body, 'utf8'),
        Buffer.from(fileHeader, 'utf8'),
        pdfContent,
        Buffer.from(afterFile, 'utf8'),
    ]);
    return client.request('POST', `/api/lecture/lectures/${lectureId}/attachment-video-units`, {
        body: bodyBuffer,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        contentType: 'multipart',
    });
}

// -- Exams --------------------------------------------------------------------

async function createExam(client, courseId, title, isPast) {
    const now = Date.now();
    let visibleDate, startDate, endDate;
    if (isPast) {
        visibleDate = daysFromNow(-60);
        startDate = daysFromNow(-45);
        endDate = daysFromNow(-45 + 0.125); // +3 hours
    } else {
        visibleDate = daysFromNow(30);
        startDate = daysFromNow(45);
        endDate = daysFromNow(45 + 0.125);
    }

    const exam = {
        title,
        testExam: false,
        visibleDate,
        startDate,
        endDate,
        workingTime: 120 * 60,
        examMaxPoints: 100,
        numberOfExercisesInExam: 5,
        course: { id: courseId },
    };
    return (await client.post(`/api/exam/courses/${courseId}/exams`, exam)).data;
}

async function createExerciseGroup(client, courseId, examId, title) {
    const exerciseGroup = { title, isMandatory: true, exam: { id: examId } };
    return (await client.post(`/api/exam/courses/${courseId}/exams/${examId}/exercise-groups`, exerciseGroup)).data;
}

async function createExamExercise(client, courseId, groupId, title, type, courseData) {
    const sn = uniqueShortName('ex');
    if (type === 'programming') {
        const exercise = {
            type: 'programming',
            title: sanitizeProgrammingTitle(title),
            shortName: sn,
            exerciseGroup: { id: groupId },
            programmingLanguage: 'JAVA',
            projectType: 'PLAIN_GRADLE',
            maxPoints: 20,
            assessmentType: 'AUTOMATIC',
            packageName: 'de.tum.cit.aet',
            allowOnlineEditor: true,
            staticCodeAnalysisEnabled: false,
            problemStatement: `Implement: ${title}`,
            buildConfig: {
                buildScript: '#!/usr/bin/env bash\nset -e\nchmod +x ./gradlew && ./gradlew clean test',
                checkoutSolutionRepository: false,
            },
        };
        return (await client.post('/api/programming/programming-exercises/setup', exercise)).data;
    } else if (type === 'text') {
        const exercise = {
            type: 'text',
            title,
            exerciseGroup: { id: groupId },
            maxPoints: 20,
            assessmentType: 'MANUAL',
            problemStatement: `Write about: ${title}`,
        };
        return (await client.post('/api/text/text-exercises', exercise)).data;
    } else if (type === 'modeling') {
        const exercise = {
            type: 'modeling',
            title,
            exerciseGroup: { id: groupId },
            maxPoints: 20,
            assessmentType: 'MANUAL',
            diagramType: 'ClassDiagram',
            problemStatement: `Model: ${title}`,
        };
        return (await client.post('/api/modeling/modeling-exercises', exercise)).data;
    } else if (type === 'quiz') {
        const quizData = courseData.exercises.quiz[0];
        const exercise = {
            type: 'quiz',
            title,
            exerciseGroup: { id: groupId },
            duration: 600,
            quizQuestions: (quizData?.questions || []).slice(0, 1).map(q => ({
                type: 'multiple-choice',
                title: q.title,
                text: q.text,
                points: 20,
                singleChoice: true,
                scoringType: 'ALL_OR_NOTHING',
                invalid: false,
                randomizeOrder: false,
                answerOptions: (q.answerOptions || []).map(a => ({ text: a.text, isCorrect: !!a.isCorrect, invalid: false })),
            })),
        };
        const { body, contentType } = createMultipartFormData({ exercise });
        return (await client.post(`/api/quiz/exercise-groups/${groupId}/quiz-exercises`, body, {
            headers: { 'Content-Type': contentType },
            contentType: 'multipart',
        })).data;
    } else if (type === 'file-upload') {
        const exercise = {
            type: 'file-upload',
            title,
            exerciseGroup: { id: groupId },
            maxPoints: 20,
            assessmentType: 'MANUAL',
            filePattern: 'pdf',
            problemStatement: `Upload: ${title}`,
        };
        return (await client.post('/api/fileupload/file-upload-exercises', exercise)).data;
    }
}

// -- FAQs ---------------------------------------------------------------------

async function createFaq(client, courseId, faq) {
    const data = {
        courseId,
        questionTitle: faq.title,
        questionAnswer: faq.answer,
        faqState: 'ACCEPTED',
        categories: ['General'],
    };
    return client.post(`/api/communication/courses/${courseId}/faqs`, data);
}

// -- Exercise Channel Messages ------------------------------------------------

async function getExerciseChannel(client, courseId, exerciseId) {
    try {
        return (await client.get(`/api/communication/courses/${courseId}/exercises/${exerciseId}/channel`)).data;
    } catch (e) {
        return null;
    }
}

async function postExerciseMessages(client, courseId, exerciseId, messagePool, count) {
    const channel = await getExerciseChannel(client, courseId, exerciseId);
    if (!channel) return 0;
    const msgs = fill(messagePool, count);
    let posted = 0;
    for (const msg of msgs) {
        const result = await postMessage(client, courseId, channel.id, msg);
        if (result) posted++;
    }
    return posted;
}

// -- Channel & Messages -------------------------------------------------------

async function createChannel(client, courseId, name) {
    const channelData = {
        name,
        description: `Discussion channel for ${name}`,
        isPublic: true,
        isAnnouncementChannel: false,
        isCourseWide: true,
    };
    try {
        return (await client.post(`/api/communication/courses/${courseId}/channels`, channelData)).data;
    } catch (e) {
        console.log(`    Could not create channel "${name}": ${e.response?.status || e.message}`);
        return null;
    }
}

async function postMessage(client, courseId, channelId, content) {
    const post = {
        content,
        hasForwardedMessages: false,
        conversation: { id: channelId },
    };
    try {
        const result = (await client.post(`/api/communication/courses/${courseId}/messages`, post)).data;
        // Throttle: each message triggers async push-notification tasks; posting too fast fills the
        // server's thread pool and causes TaskRejectedException for subsequent requests.
        await new Promise(r => setTimeout(r, 200));
        return result;
    } catch (e) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

async function buildOneCourse(client, courseData, courseIndex) {
    const label = `[${courseIndex + 1}/${NUM_COURSES}] ${courseData.title}`;
    console.log(`\n${label}`);

    // Half the content is in the past, half in the future
    const pastRatio = courseIndex % 2 === 0;

    // 1. Create course
    const course = await createCourse(client, courseData, courseIndex);
    const courseId = course.id;
    console.log(`  Course created (id=${courseId})`);

    // 2. Exercises (70 total) with messages per exercise channel
    console.log('  Creating exercises...');
    const createdExercises = [];
    let exerciseErrorCount = 0;
    let exerciseMsgTotal = 0;
    const exerciseMessagePool = courseData.exerciseMessages || courseData.channelMessages || [];
    for (const [type, count] of Object.entries(EXERCISE_DISTRIBUTION)) {
        const pool = courseData.exercises[type === 'file-upload' ? 'fileUpload' : type] || [];
        const items = fill(pool, count);
        for (let i = 0; i < items.length; i++) {
            const releasePast = pastRatio ? i < items.length / 2 : i >= items.length / 2;
            try {
                let ex;
                if (type === 'programming') {
                    ex = await createProgrammingExercise(client, courseId, items[i], releasePast);
                    // Throttle: programming exercise creation triggers async repo/CI setup server-side;
                    // without a pause the executor queue fills up and subsequent requests get rejected.
                    await new Promise(r => setTimeout(r, 2000));
                } else if (type === 'text') ex = await createTextExercise(client, courseId, items[i], releasePast);
                else if (type === 'modeling') ex = await createModelingExercise(client, courseId, items[i], releasePast);
                else if (type === 'quiz') ex = await createQuizExercise(client, courseId, items[i], releasePast);
                else if (type === 'file-upload') ex = await createFileUploadExercise(client, courseId, items[i], releasePast);
                if (ex) {
                    createdExercises.push(ex);
                    const posted = await postExerciseMessages(client, courseId, ex.id, exerciseMessagePool, TARGET_EXERCISE_MESSAGES);
                    exerciseMsgTotal += posted;
                }
            } catch (e) {
                exerciseErrorCount++;
                if (exerciseErrorCount <= 3) {
                    const detail = typeof e.response?.data === 'string' ? e.response.data : JSON.stringify(e.response?.data);
                    console.log(`    Error creating ${type} exercise: ${e.message} — ${detail}`);
                }
            }
        }
    }
    console.log(`  Created ${createdExercises.length} exercises (${exerciseErrorCount} errors), ${exerciseMsgTotal} exercise messages`);

    // 3. Lectures (20 with 5 units each)
    console.log('  Creating lectures...');
    const lecturePool = fill(courseData.lectures, TARGET_LECTURES);
    let lectureCount = 0;
    for (let i = 0; i < lecturePool.length; i++) {
        const releasePast = i < lecturePool.length / 2;
        try {
            const lecture = await createLecture(client, courseId, lecturePool[i], releasePast);
            const units = fill(lecturePool[i].units, TARGET_LECTURE_UNITS);
            for (const unit of units) {
                try {
                    if (unit.type === 'text') await createTextUnit(client, lecture.id, unit, releasePast);
                    else if (unit.type === 'online') await createOnlineUnit(client, lecture.id, unit, releasePast);
                    else if (unit.type === 'attachment') await createAttachmentUnit(client, lecture.id, unit, releasePast);
                } catch (e) {
                    // skip unit errors silently
                }
            }
            lectureCount++;
        } catch (e) {
            console.log(`    Error creating lecture: ${e.response?.data?.message || e.message}`);
        }
    }
    console.log(`  Created ${lectureCount} lectures`);

    // 4. FAQs (20)
    console.log('  Creating FAQs...');
    const faqPool = fill(courseData.faqs, TARGET_FAQS);
    let faqCount = 0;
    for (const faq of faqPool) {
        try {
            await createFaq(client, courseId, faq);
            faqCount++;
        } catch (e) {
            // skip
        }
    }
    console.log(`  Created ${faqCount} FAQs`);

    // 5. Exams (1 past, 1 future) with 5 exercise groups x 3 exercises
    console.log('  Creating exams...');
    const examTypes = ['programming', 'text', 'modeling', 'quiz', 'file-upload'];
    for (const isPast of [true, false]) {
        const examLabel = isPast ? 'Past' : 'Upcoming';
        try {
            const exam = await createExam(client, courseId, `${examLabel} ${courseData.topic} Exam`, isPast);
            for (let g = 0; g < 5; g++) {
                const groupType = examTypes[g];
                const group = await createExerciseGroup(client, courseId, exam.id, `${groupType} Group ${g + 1}`);
                for (let e = 0; e < 3; e++) {
                    const exTitle = `${examLabel} ${courseData.topic} ${groupType} ${g + 1}.${e + 1}`;
                    try {
                        await createExamExercise(client, courseId, group.id, exTitle, groupType, courseData);
                    } catch (err) {
                        // skip individual exam exercise errors
                    }
                }
            }
            console.log(`  Created ${examLabel} exam (id=${exam.id})`);
        } catch (e) {
            console.log(`  Error creating ${examLabel} exam: ${e.response?.data?.message || e.message}`);
        }
    }

    // 6. Channel with messages
    console.log('  Creating channel and messages...');
    const channelName = courseData.shortNamePrefix.toLowerCase() + '-discussion';
    const channel = await createChannel(client, courseId, channelName);
    if (channel) {
        const msgs = fill(courseData.channelMessages, TARGET_CHANNEL_MESSAGES);
        let msgCount = 0;
        for (const msg of msgs) {
            const result = await postMessage(client, courseId, channel.id, msg);
            if (result) msgCount++;
        }
        console.log(`  Posted ${msgCount} messages in #${channelName}`);
    }

    console.log(`  Done with "${courseData.title}"`);
}

async function run() {
    console.log(`=== Weaviate Search Test Data Generator ===`);
    console.log(`Server: ${serverUrl}`);
    console.log(`Courses: ${NUM_COURSES}`);
    console.log(`Available course themes: ${ALL_COURSES.length}`);
    console.log();

    const client = new HttpClient(serverUrl);
    await authenticate(client, ADMIN_USER, ADMIN_PASSWORD);
    console.log('Authenticated as admin');

    for (let i = 0; i < NUM_COURSES; i++) {
        const courseData = ALL_COURSES[i % ALL_COURSES.length];
        await buildOneCourse(client, courseData, i);
    }

    console.log('\n=== All done! ===');
    console.log(`Created ${NUM_COURSES} courses with exercises, lectures, FAQs, exams, and channel messages.`);
}

run().catch(err => {
    console.error('Fatal error:', err.message);
    console.error('Response content-type:', err.response?.contentType);
    console.error('Response data type:', typeof err.response?.data);
    console.error('Response data:', err.response?.data);
    process.exit(1);
});
