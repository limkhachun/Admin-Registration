const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler"); 
const { onCall, HttpsError } = require("firebase-functions/v2/https"); // 🟢 新增：引入 v2 HTTPS 模块用于客户端调用
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const { logger } = require("firebase-functions");

// 🟢 初始化 Admin SDK (增加防重复初始化判定，避免云函数重启时报错)
if (!admin.apps.length) {
    admin.initializeApp();
}

// 🟢 强制设置云函数部署在亚洲（与您的 Firestore 数据库保持一致）
setGlobalOptions({ region: 'asia-southeast1' });


// ============================================================================
// 1. 公告推送 (Announcement Push)
// ============================================================================
exports.sendAnnouncementPush = onDocumentCreated('announcements/{docId}', async (event) => {
    const snap = event.data;
    if (!snap) return;

    const data = snap.data();
    const messageBody = data.message || "A new announcement has been posted.";

    try {
        const usersSnap = await admin.firestore().collection('users')
            .where('status', 'in', ['active', 'locked']) 
            .get();

        const tokens = [];
        usersSnap.forEach(doc => {
            const u = doc.data();
            if (u.fcmToken) {
                tokens.push(u.fcmToken);
            }
        });

        if (tokens.length === 0) {
            logger.info("No users have FCM tokens. Skipping announcement push.");
            return;
        }

        const payload = {
            notification: {
                title: "📢 New Company Announcement",
                body: messageBody,
            },
            tokens: tokens
        };

        const response = await admin.messaging().sendEachForMulticast(payload);
        logger.info(`Announcement sent. Success count: ${response.successCount}`);
    } catch (error) {
        logger.error("Error sending announcement push:", error);
    }
});


// ============================================================================
// 2. 假期审批推送 (Leave Update Push)
// ============================================================================
exports.sendLeaveUpdatePush = onDocumentUpdated('leaves/{leaveId}', async (event) => {
    const change = event.data;
    if (!change) return;

    const newData = change.after.data();
    const oldData = change.before.data();

    if (oldData.status === newData.status) return;

    const authUid = newData.authUid || newData.uid;
    if (!authUid) return;

    try {
        const userQuery = await admin.firestore().collection('users').where('authUid', '==', authUid).limit(1).get();
        if (userQuery.empty) return;

        const fcmToken = userQuery.docs[0].data().fcmToken;
        if (!fcmToken) return;

        const payload = {
            notification: {
                title: "🏖️ Leave Request Update",
                body: `Your request for ${newData.type} has been ${newData.status}.`,
            },
            token: fcmToken
        };

        await admin.messaging().send(payload);
        logger.info(`Leave push sent successfully to ${authUid}`);
    } catch (error) {
        logger.error("Error sending leave push:", error);
    }
});


// ============================================================================
// 3. 薪资单发布推送 (Payslip Published Push)
// ============================================================================
exports.sendPayslipPush = onDocumentWritten('payslips/{payslipId}', async (event) => {
    const change = event.data;
    if (!change) return;

    const docData = change.after.exists ? change.after.data() : null;
    
    if (!docData) return;
    if (docData.status !== 'Published') return;

    if (change.before.exists) {
        const beforeData = change.before.data();
        if (beforeData.status === 'Published') return; 
    }

    const uid = docData.uid; 
    if (!uid) return;

    try {
        const userDoc = await admin.firestore().collection('users').doc(uid).get();
        if (!userDoc.exists) return;

        const fcmToken = userDoc.data().fcmToken;
        if (!fcmToken) return;

        const payload = {
            notification: {
                title: "💰 Payslip Available",
                body: `Your payslip for ${docData.month} has been published and is ready to view.`,
            },
            token: fcmToken
        };

        await admin.messaging().send(payload);
        logger.info(`Payslip push sent to user ${uid}`);
    } catch (error) {
        logger.error("Error sending payslip push:", error);
    }
});


// ============================================================================
// 4. 自动签退补齐 (Auto Clock Out Job) - 每天 23:59 触发
// ============================================================================
exports.autoClockOutJob = onSchedule({
    schedule: "*/15 * * * *",  // Changed: Runs every 15 minutes
    timeZone: "Asia/Kuala_Lumpur", 
    retryCount: 3                  
}, async (event) => {
    const db = admin.firestore();
    
    const now = new Date();
    const mytTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
    const todayStr = mytTime.getFullYear() + "-" + 
                     String(mytTime.getMonth() + 1).padStart(2, '0') + "-" + 
                     String(mytTime.getDate()).padStart(2, '0');

    const currentMinutes = (mytTime.getHours() * 60) + mytTime.getMinutes();

    try {
        const attendanceRef = db.collection("attendance").where("date", "==", todayStr);
        const snapshot = await attendanceRef.get();

        const userRecords = {};

        snapshot.forEach(doc => {
            const data = doc.data();
            const identifier = data.uid || data.userId; 
            
            if (!identifier || !data.timestamp) return;

            if (!userRecords[identifier]) {
                userRecords[identifier] = [];
            }
            userRecords[identifier].push(data);
        });

        let batch = db.batch();
        let fixCount = 0;
        let batchOperationCount = 0; 

        for (const [identifier, records] of Object.entries(userRecords)) {
            
            records.sort((a, b) => {
                const timeA = a.timestamp.toMillis ? a.timestamp.toMillis() : a.timestamp;
                const timeB = b.timestamp.toMillis ? b.timestamp.toMillis() : b.timestamp;
                return timeB - timeA; 
            });

            const latestRecord = records[0];

            if (latestRecord.session === "Clock In") {
                
                const userDoc = await db.collection("users").doc(identifier).get();
                if (!userDoc.exists) continue;
                const userData = userDoc.data();

                const scheduledEndTimeStr = userData.scheduleEndTime || "18:00"; 
                
                const [endHour, endMin] = scheduledEndTimeStr.split(':').map(Number);
                const scheduledEndMinutes = (endHour * 60) + endMin;

                const gracePeriodMinutes = 30; 

                if (currentMinutes >= (scheduledEndMinutes + gracePeriodMinutes)) {
                    
                    const newRecordRef = db.collection("attendance").doc();
                    
                    const forceTimestamp = admin.firestore.Timestamp.fromDate(now);
                    const manualOutTime = `${String(mytTime.getHours()).padStart(2, '0')}:${String(mytTime.getMinutes()).padStart(2, '0')}`;

                    batch.set(newRecordRef, {
                        uid: identifier,
                        name: latestRecord.name || "Unknown Staff",
                        email: latestRecord.email || "",
                        date: todayStr,
                        session: "Clock Out",
                        manualOut: manualOutTime,
                        verificationStatus: "Verified",
                        address: "System Auto Clock Out", 
                        remarks: `Forced by system due to missing clock out after scheduled shift (${scheduledEndTimeStr})`,
                        timestamp: forceTimestamp
                    });

                    fixCount++;
                    batchOperationCount++;
                    logger.info(`[Fixed] Auto Clock Out enforced for ${latestRecord.name || identifier} at ${manualOutTime}`);

                    if (batchOperationCount === 450) {
                        await batch.commit();
                        batch = db.batch(); 
                        batchOperationCount = 0;
                    }
                }
            }
        }

        if (batchOperationCount > 0) {
            await batch.commit();
        }

        if (fixCount > 0) {
            logger.info(`✅ Successfully fixed ${fixCount} missing clock outs up to ${mytTime.getHours()}:${mytTime.getMinutes()}.`);
        }

    } catch (error) {
        logger.error("❌ Error in Auto Clock Out Job:", error);
    }
});


// ============================================================================
// 5. 强制重置用户密码 (Reset User Password) - 供 Flutter App 客户端调用
// ============================================================================
exports.resetUserPassword = onCall(async (request) => {
    // 🟢 v2 语法的参数提取方式是 request.data
    const uid = request.data.uid;
    const newPassword = request.data.newPassword;

    if (!uid || !newPassword) {
        throw new HttpsError(
            'invalid-argument', 
            'The function must be called with a "uid" and "newPassword".'
        );
    }

    try {
        // 使用 Admin SDK 强制更新该 UID 的密码
        await admin.auth().updateUser(uid, {
            password: newPassword
        });
        
        logger.info(`Password successfully reset for UID: ${uid}`);
        return { success: true, message: "Password successfully updated." };
    } catch (error) {
        logger.error(`Error updating password for UID ${uid}:`, error);
        throw new HttpsError('internal', error.message);
    }
});