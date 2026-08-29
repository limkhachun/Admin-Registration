// payroll-app.js
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, query, where, getDocs, doc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, getDoc, onSnapshot, runTransaction } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { formatMoney, formatTime, calculateStatutoryAmount, msToHM, logAdminAction, showLoading, hideLoading, showStatusAlert } from './utils.js';
import { requireAdmin } from './auth-guard.js';

window.formatMoney = formatMoney;

window.onerror = function(msg) {
    const loadingText = document.getElementById('loadingText');
    if(loadingText) { loadingText.innerText = "Error: " + msg; loadingText.classList.add('text-danger'); }
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app); 

let currentPayrollData = [];
let staffMap = {}; 
let holidaysMap = {}; 
let formModal, printModal, advancesModal, settingsModal;
let globalSettings = { calcMode: 'daily', satMultiplier: 1.0, lateMode: 'minutes', lateFixedAmount: 10, defaultCompany: 'RH RIDER HUB MOTOR (M) SDN. BHD.' }; 

const safeSetVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
const safeSetText = (id, text) => { const el = document.getElementById(id); if (el) el.innerText = text; };

// 🟢 马来西亚法定扣款计算引擎 (EPF/SOCSO/EIS/SKBKK)
function calculateMalaysiaStatutory(earnedBasic, commission, allowance, overtime, epfRateRaw) {
    // 🌟 修改点：根据需求，Allowance 和 Overtime 都不计入 EPF, SOCSO 和 EIS 的计算基数中
    const epfGross = earnedBasic + commission;
    const socsoEisGross = earnedBasic + commission;

    let epfEmp = 0;
    let epfEmpr = 0;
    if (epfGross > 0) {
        const epfBracketMax = Math.ceil(epfGross / 20) * 20; 
        const empEpfRate = parseFloat(epfRateRaw) || 11;
        const employerEpfRate = epfGross <= 5000 ? 0.13 : 0.12; 
        
        epfEmp = Math.ceil(epfBracketMax * (empEpfRate / 100));
        epfEmpr = Math.ceil(epfBracketMax * employerEpfRate);
    }

    let socsoEmp = 0, socsoEmpr = 0, eisEmp = 0, eisEmpr = 0, skbkkEmp = 0;
    if (socsoEisGross > 0) {
        const capGross = Math.min(socsoEisGross, 6000);

        if (capGross <= 30) {
            socsoEmp = 0.10; socsoEmpr = 0.40; eisEmp = 0.05; eisEmpr = 0.05;
        } else if (capGross <= 50) {
            socsoEmp = 0.20; socsoEmpr = 0.70; eisEmp = 0.10; eisEmpr = 0.10;
        } else if (capGross <= 70) {
            socsoEmp = 0.30; socsoEmpr = 1.10; eisEmp = 0.15; eisEmpr = 0.15;
        } else if (capGross <= 100) {
            socsoEmp = 0.40; socsoEmpr = 1.45; eisEmp = 0.20; eisEmpr = 0.20;
        } else if (capGross <= 140) {
            socsoEmp = 0.60; socsoEmpr = 2.05; eisEmp = 0.25; eisEmpr = 0.25;
        } else if (capGross <= 200) {
            socsoEmp = 0.85; socsoEmpr = 2.95; eisEmp = 0.35; eisEmpr = 0.35;
        } else {
            const bracketMax = Math.ceil(capGross / 100) * 100;
            const midPoint = bracketMax - 50; 

            eisEmp = +(midPoint * 0.002).toFixed(2);
            eisEmpr = eisEmp;

            socsoEmp = +(midPoint * 0.005).toFixed(2);
            
            const totalSocso = Math.round(midPoint * 0.0225 * 10) / 10;
            socsoEmpr = +(totalSocso - socsoEmp).toFixed(2);
        }
        
        // Calculate new SKBKK (0.75% of SOCSO gross, capped at 6000)
        skbkkEmp = +(capGross * 0.0075).toFixed(2);
    }

    return {
        epfEmp: epfEmp,
        epfEmpr: epfEmpr,
        socsoEmp: socsoEmp,
        socsoEmpr: socsoEmpr,
        eisEmp: eisEmp,
        eisEmpr: eisEmpr,
        skbkkEmp: skbkkEmp
    };
}

// ==========================================
// INITIALIZATION
// ==========================================
requireAdmin(app, db, async (user) => {
    try {
        showLoading(); 
        
        if (typeof bootstrap !== 'undefined') {
            formModal = new bootstrap.Modal(document.getElementById('payslipFormModal'));
            printModal = new bootstrap.Modal(document.getElementById('printModal'));
            advancesModal = new bootstrap.Modal(document.getElementById('advancesModal'));
            settingsModal = new bootstrap.Modal(document.getElementById('settingsModal'));
        }

        const now = new Date();
        const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        document.getElementById('globalMonthPicker').value = monthStr;
        document.getElementById('formMonthPicker').value = monthStr;

        await loadSettings();
        await loadStaffData(); 
        await window.loadPayroll();
        listenToAdvances(); 

        document.getElementById('mainContainer').classList.remove('d-none');
    } catch (e) {
        console.error("Init Error:", e);
        showStatusAlert('statusMessage', 'Failed to initialize Payroll system.', false); 
    } finally {
        hideLoading(); 
        lucide.createIcons();
    }
});

// ==========================================
// 1. SETTINGS & HOLIDAYS
// ==========================================
async function loadSettings() {
    try {
        const snap = await getDoc(doc(db, "settings", "payroll_config"));
        if (snap.exists()) globalSettings = { ...globalSettings, ...snap.data() };
        
        safeSetVal('configCalcMode', globalSettings.calcMode);
        safeSetVal('configSatMulti', globalSettings.satMultiplier);
        safeSetVal('configLateMode', globalSettings.lateMode || 'minutes');
        safeSetVal('configLateAmount', globalSettings.lateFixedAmount || 10);
        safeSetVal('configDefaultCompany', globalSettings.defaultCompany || 'RH RIDER HUB MOTOR (M) SDN. BHD.');
        
        window.toggleSettingsView();
        window.toggleLateSettings();

        const holSnap = await getDoc(doc(db, "settings", "holidays"));
        if (holSnap.exists() && holSnap.data().holiday_list) {
            holSnap.data().holiday_list.forEach(h => { holidaysMap[h.date] = h.name; });
        }
    } catch (e) { console.error("Settings load error", e); }
}

window.toggleSettingsView = () => {
    const mode = document.getElementById('configCalcMode')?.value || globalSettings.calcMode;
    const hint = document.getElementById('calcModeHint');
    const satBox = document.getElementById('satConfigBox');
    if(hint) {
        if (mode === 'hourly') {
            hint.innerText = "Pays based on strictly total hours worked.";
            if(satBox) satBox.classList.add('d-none');
        } else {
            hint.innerText = "Pays based on days worked + paid leave days.";
            if(satBox) satBox.classList.remove('d-none');
        }
    }
};

window.toggleLateSettings = () => {
    const mode = document.getElementById('configLateMode')?.value || 'minutes';
    const amountBox = document.getElementById('lateFixedAmountBox');
    if(amountBox) {
        mode === 'times' ? amountBox.classList.remove('d-none') : amountBox.classList.add('d-none');
    }
};

window.saveSettings = async () => {
    const newConfig = { 
        calcMode: document.getElementById('configCalcMode').value, 
        satMultiplier: parseFloat(document.getElementById('configSatMulti').value), 
        lateMode: document.getElementById('configLateMode').value, 
        lateFixedAmount: parseFloat(document.getElementById('configLateAmount').value) || 0,
        defaultCompany: document.getElementById('configDefaultCompany').value
    };
    
    showLoading();
    try {
        const oldSnap = await getDoc(doc(db, "settings", "payroll_config"));
        await setDoc(doc(db, "settings", "payroll_config"), newConfig, { merge: true });
        
        await logAdminAction(db, auth.currentUser, "UPDATE_PAYROLL_SETTINGS", "GLOBAL", oldSnap.exists() ? oldSnap.data() : null, newConfig);

        globalSettings = { ...globalSettings, ...newConfig };
        settingsModal.hide();
        hideLoading();
        showStatusAlert('statusMessage', "Settings Saved! Please re-save Drafts.", true); 
    } catch (e) { 
        hideLoading();
        showStatusAlert('statusMessage', "Error saving settings: " + e.message, false); 
    }
};

window.openSettingsModal = () => settingsModal.show();

// ==========================================
// 2. SALARY ADVANCES
// ==========================================
function listenToAdvances() {
    onSnapshot(query(collection(db, "salary_advances"), where("status", "==", "Pending")), (snap) => {
        const badge = document.getElementById('advanceBadge');
        if(!badge) return;
        if (snap.empty) badge.classList.add('d-none');
        else { badge.classList.remove('d-none'); badge.innerText = snap.size; }
    });
}

window.openAdvancesModal = async () => {
    const listDiv = document.getElementById('advancesList');
    listDiv.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-muted">Loading...</td></tr>';
    document.getElementById('advanceModalAlert').classList.add('d-none');
    advancesModal.show();

    try {
        const snap = await getDocs(query(collection(db, "salary_advances")));
        let html = ""; let count = 0;

        snap.forEach(d => {
            const data = d.data();
            if(data.isDeducted || data.status === 'Rejected') return; 

            count++;
            let actionHtml = "";
            let statusBadge = "";

            if (data.status === 'Pending') {
                statusBadge = `<span class="badge bg-warning text-dark px-2 py-1">Pending</span>`;
                actionHtml = `
                    <button class="btn btn-sm btn-success fw-bold px-3 py-1 me-1 shadow-sm" onclick="window.updateAdvanceStatus('${d.id}', 'Approved')">Approve</button>
                    <button class="btn btn-sm btn-outline-danger fw-bold px-3 py-1" onclick="window.updateAdvanceStatus('${d.id}', 'Rejected')">Reject</button>
                `;
            } else if (data.status === 'Approved') {
                if (data.isTransferred) {
                    statusBadge = `<span class="badge bg-success px-2 py-1"><i data-lucide="check-double" class="size-3 me-1"></i> Transferred</span>`;
                    actionHtml = `<span class="text-success small fw-bold"><i data-lucide="check-circle" class="size-3"></i> Ready for Deduction</span>`;
                } else {
                    statusBadge = `<span class="badge bg-info text-dark px-2 py-1"><i data-lucide="clock" class="size-3 me-1"></i> Awaiting Transfer</span>`;
                    actionHtml = `
                        <button class="btn btn-sm btn-primary fw-bold px-3 py-1 me-1 shadow-sm" onclick="window.markAdvanceTransferred('${d.id}')">Mark Transferred</button>
                        <button class="btn btn-sm btn-light border text-danger py-1" onclick="window.updateAdvanceStatus('${d.id}', 'Rejected')">Revoke</button>
                    `;
                }
            }

            html += `
                <tr class="align-middle">
                    <td class="ps-4"><div class="fw-bold text-dark">${data.empName || '-'}</div><small class="text-muted">${data.empCode || ''}</small></td>
                    <td class="text-danger fw-bold fs-6">RM ${formatMoney(data.amount)}</td>
                    <td class="text-secondary" style="max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${data.reason || '-'}">${data.reason || '-'}</td>
                    <td>${statusBadge}</td>
                    <td class="text-end pe-4">${actionHtml}</td>
                </tr>
            `;
        });
        
        listDiv.innerHTML = count > 0 ? html : '<tr><td colspan="5" class="text-center py-5 text-muted fw-bold">No pending/active requests found.</td></tr>';
        lucide.createIcons();
    } catch (e) { console.error(e); }
};

window.updateAdvanceStatus = async (id, status) => {
    showLoading(); 
    try {
        const docRef = doc(db, "salary_advances", id);
        const oldSnap = await getDoc(docRef);
        const oldData = oldSnap.data();

        await updateDoc(docRef, { status: status, updatedAt: serverTimestamp() });
        await logAdminAction(db, auth.currentUser, "APPROVE_ADVANCE", oldData.uid, { status: oldData.status }, { status: status, amount: oldData.amount });

        hideLoading();
        showModalAlert(`Request successfully marked as ${status}.`, 'success');
        window.openAdvancesModal(); 
    } catch (e) { 
        hideLoading();
        showModalAlert("Error: " + e.message, 'danger'); 
    }
};

window.markAdvanceTransferred = async (id) => {
    if(!confirm("Are you sure you have transferred the funds to the employee's bank account?\n\nOnce marked as transferred, it will be automatically deducted from their next payslip.")) return;
    
    showLoading();
    try {
        const docRef = doc(db, "salary_advances", id);
        await updateDoc(docRef, { 
            isTransferred: true, 
            transferredAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        
        hideLoading();
        showModalAlert('Funds marked as transferred successfully!', 'success');
        window.openAdvancesModal(); 
    } catch (e) {
        hideLoading();
        showModalAlert("Error: " + e.message, 'danger'); 
    }
};

function showModalAlert(msg, type) {
    const alertBox = document.getElementById('advanceModalAlert');
    if(!alertBox) return;
    alertBox.className = `alert alert-${type} m-3 small fw-bold text-center`;
    alertBox.innerText = msg;
    alertBox.classList.remove('d-none');
    setTimeout(() => { alertBox.classList.add('d-none'); }, 4000);
}

// ==========================================
// 3. CORE PAYROLL LOGIC (ABSENT / UNPAID / UNSCHEDULED)
// ==========================================
async function loadStaffData() {
    const snap = await getDocs(query(collection(db, "users")));
    staffMap = {}; 
    const select = document.getElementById('staffSelect');
    if(!select) return;
    select.innerHTML = '<option value="">-- Choose Staff --</option>';

    snap.forEach(doc => {
        const s = doc.data();
        if (s.status === 'disabled' || s.role === 'manager') return;
        const personal = s.personal || {}; 
        const displayName = personal.name || s.name || 'Unknown Staff';
        staffMap[doc.id] = { 
            id: doc.id, authUid: s.authUid, ...s, 
            displayName: displayName, 
            displayId: personal.empCode || s.staffId || '--'
        };
        select.innerHTML += `<option value="${doc.id}">${displayName} (${personal.empCode || 'No ID'})</option>`;
    });
}

window.autoFillStaffData = async () => {
    const uid = document.getElementById('staffSelect').value;
    const monthStr = document.getElementById('formMonthPicker').value;
    if (!uid || !monthStr) return;

    const staff = staffMap[uid]; 
    const isHourly = globalSettings.calcMode === 'hourly';
    
    safeSetText('calcModeBadge', isHourly ? 'Mode: Hourly Rate' : 'Mode: Daily Rate');
    const badgeEl = document.getElementById('calcModeBadge');
    if(badgeEl) badgeEl.className = isHourly ? 'badge bg-primary me-2' : 'badge bg-success me-2';
    
    // MODIFIED: Manage the termBadge on the UI if a termDate applies this month
    const termDate = staff?.employment?.termDate;
    const isTerminatedThisMonth = termDate && termDate.startsWith(monthStr);
    const termBadge = document.getElementById('termBadge');
    if (termBadge) termBadge.classList.toggle('d-none', !isTerminatedThisMonth);

    const boxStdDays = document.getElementById('boxStdDays');
    const boxHourlyRate = document.getElementById('boxHourlyRate');
    if(boxStdDays) boxStdDays.classList.toggle('d-none', isHourly);
    if(boxHourlyRate) boxHourlyRate.classList.toggle('d-none', !isHourly);

    let totalAdv = 0; let advIds = [];
    if(staff) {
        try {
            const targetIds = [String(uid)];
            if (staff.authUid) targetIds.push(String(staff.authUid));
            
            const advSnap = await getDocs(query(collection(db, "salary_advances"), where("uid", "in", targetIds), where("status", "==", "Approved"), where("isDeducted", "==", false)));
            advSnap.forEach(d => {
                const adv = d.data();
                if (adv.isTransferred === true) {
                    totalAdv += adv.amount; 
                    advIds.push(d.id); 
                }
            });
        } catch (e) { console.error("Error fetching advances", e); }
    }

    if(staff) {
        safeSetVal('inpBasic', staff.payroll?.basic || 0);
        safeSetVal('inpAdvance', totalAdv);
        safeSetVal('pendingAdvanceIds', JSON.stringify(advIds));
        window.recalcStatutoryAndTotals(); 
    }

    showLoading(); 
    await calculateAttendanceStats(uid, monthStr);
    window.calcTotals('all'); 
    hideLoading(); 
};

window.recalcStatutoryAndTotals = () => {
    window.calcTotals('all');
};

async function calculateAttendanceStats(uid, monthStr) {
    const staff = staffMap[uid];
    if (!staff) return;

    const [year, month] = monthStr.split('-');
    const startDate = `${monthStr}-01`;
    let daysInMonth = new Date(year, month, 0).getDate();
    
    // --- MODIFIED LOGIC: Check for Termination Date ---
    const termDate = staff.employment?.termDate;
    if (termDate && termDate.startsWith(monthStr)) {
        // Limit the calculated days to their exact termination date
        daysInMonth = parseInt(termDate.split('-')[2], 10);
    }
    // --------------------------------------------------

    const endDate = `${monthStr}-${String(daysInMonth).padStart(2, '0')}`;
    
    const targetIds = [String(uid)];
    if (staff.authUid) targetIds.push(String(staff.authUid));

    const [allSchedSnap, myLeavesSnap, myAttSnap] = await Promise.all([
        getDocs(query(collection(db, "schedules"), where("date", ">=", startDate), where("date", "<=", endDate))),
        getDocs(query(collection(db, "leaves"), where("uid", "in", targetIds), where("status", "==", "Approved"))),
        getDocs(query(collection(db, "attendance"), where("uid", "in", targetIds), where("date", ">=", startDate), where("date", "<=", endDate)))
    ]);

    const mySchedules = {}; let mySchedCount = 0;
    const userSchedCounts = {}; 
    const userSchedHours = {}; 

    allSchedSnap.forEach(d => { 
        const s = d.data(); 
        if(targetIds.includes(s.userId)){ 
            mySchedules[s.date] = s; 
            mySchedCount++; 
        } 
        userSchedCounts[s.userId] = (userSchedCounts[s.userId] || 0) + 1; 
        
        if(s.start && s.end) {
            const start = s.start.toDate ? s.start.toDate() : new Date(s.start);
            const end = s.end.toDate ? s.end.toDate() : new Date(s.end);
            let duration = (end - start) / 3600000;
            duration -= (s.breakMins || 0) / 60;
            if (duration > 0) userSchedHours[s.userId] = (userSchedHours[s.userId] || 0) + duration;
        }
    });

    const attMap = {};
    myAttSnap.forEach(d => {
        const a = d.data();
        if (a.verificationStatus === 'Verified') {
            if(!attMap[a.date]) attMap[a.date] = { in: null, out: null, breakOut: null, breakIn: null };
            if(a.session === 'Clock In') attMap[a.date].in = a.manualIn || a.timeIn || a.timestamp;
            if(a.session === 'Clock Out') attMap[a.date].out = a.manualOut || a.timeOut || a.timestamp;
            if(a.session === 'Break Out') attMap[a.date].breakOut = a.manualOut || a.timeOut || a.timestamp;
            if(a.session === 'Break In') attMap[a.date].breakIn = a.manualIn || a.timeIn || a.timestamp;
        }
    });

    const userLeaves = {};
    myLeavesSnap.forEach(d => {
        const l = d.data();
        const [sY, sM, sD] = l.startDate.split('-');
        const [eY, eM, eD] = l.endDate.split('-');
        let curr = new Date(sY, sM - 1, sD);
        const endD = new Date(eY, eM - 1, eD);
        
        const leaveValue = (l.days !== undefined && l.days < 1) ? parseFloat(l.days) : 1;

        while(curr <= endD) {
            const dStr = `${curr.getFullYear()}-${String(curr.getMonth() + 1).padStart(2, '0')}-${String(curr.getDate()).padStart(2, '0')}`;
            if (dStr >= startDate && dStr <= endDate) { 
                userLeaves[dStr] = { type: l.type, val: leaveValue, status: l.status || 'Approved' }; 
            }
            curr.setDate(curr.getDate() + 1);
        }
    });

    let actWorkedDays = 0, totalWorkMs = 0, totalLateMs = 0, lateCount = 0; 
    let phUnworkedDays = 0, phWorkedDays = 0, phWorkedMs = 0, phUnworkedMs = 0;
    let absentDays = 0, absentHrs = 0;

    let totalLateFraction = 0;
    let weekdayLateFraction = 0, satLateFraction = 0;
    let totalWeekdayLateMs = 0, totalSatLateMs = 0;

    const satMulti = parseFloat(globalSettings.satMultiplier || 1.0);

    const toDateObj = (t, dateStr) => {
        if(!t) return null;
        if(t.toDate) return t.toDate();
        if(typeof t === 'string' && t.includes(':')) return new Date(`${dateStr}T${t}:00`);
        return new Date(t);
    };

    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${month}-${String(d).padStart(2, '0')}`;
        const records = attMap[dateStr];
        const sched = mySchedules[dateStr];
        const leaveObj = userLeaves[dateStr];
        const leaveType = leaveObj?.type;
        const leaveVal = leaveObj?.val || 0; 
        
        const isPH = !!holidaysMap[dateStr];
        const validPH = isPH && (!!sched || !!leaveType);

        let schedDurMs = 8 * 3600000;
        if (sched && sched.start && sched.end) {
            const sStart = toDateObj(sched.start, dateStr);
            const sEnd = toDateObj(sched.end, dateStr);
            schedDurMs = sEnd - sStart;
            if (sched.breakMins) schedDurMs -= (sched.breakMins * 60000);
            if (schedDurMs <= 0) schedDurMs = 8 * 3600000;
        }

        if (records && records.in) {
            const isSat = new Date(dateStr).getDay() === 6;
            
            let actAdd = isSat ? satMulti : 1;
            if (leaveVal === 0.5) actAdd = 0.5;

            actWorkedDays += actAdd;

            if (sched && sched.start) {
                const inTime = toDateObj(records.in, dateStr);
                const schedStart = toDateObj(sched.start, dateStr);
                if (inTime > schedStart) { 
                    const lateMs = inTime - schedStart;
                    totalLateMs += lateMs; 
                    lateCount++; 
                    const frac = lateMs / schedDurMs;
                    totalLateFraction += frac; 

                    if (isSat) {
                        totalSatLateMs += lateMs;
                        satLateFraction += frac;
                    } else {
                        totalWeekdayLateMs += lateMs;
                        weekdayLateFraction += frac;
                    }
                }
            }

            let workMsThisDay = 0;
            if (records.out) {
                const inTime = toDateObj(records.in, dateStr);
                const outTime = toDateObj(records.out, dateStr);
                workMsThisDay = outTime - inTime;
                
                if (records.breakOut && records.breakIn) {
                    const breakDur = toDateObj(records.breakIn, dateStr) - toDateObj(records.breakOut, dateStr);
                    if (breakDur > 0) {
                        workMsThisDay -= breakDur;

                        const allowedBreakMins = (sched && sched.breakMins) ? sched.breakMins : 60; 
                        const allowedBreakMs = allowedBreakMins * 60000;
                        if (breakDur > allowedBreakMs) {
                            const lateMs = breakDur - allowedBreakMs;
                            totalLateMs += lateMs;
                            lateCount++;
                            const frac = lateMs / schedDurMs;
                            totalLateFraction += frac;

                            if (isSat) {
                                totalSatLateMs += lateMs;
                                satLateFraction += frac;
                            } else {
                                totalWeekdayLateMs += lateMs;
                                weekdayLateFraction += frac;
                            }
                        }
                    }
                }

                if (sched && sched.start && sched.end) {
                    const sStart = toDateObj(sched.start, dateStr);
                    const sEnd = toDateObj(sched.end, dateStr);
                    let schedDurMsLimit = sEnd - sStart;
                    if (sched.breakMins) schedDurMsLimit -= sched.breakMins * 60000;

                    if (schedDurMsLimit > 0 && workMsThisDay > schedDurMsLimit) {
                        workMsThisDay = schedDurMsLimit;
                    }
                }
                if(workMsThisDay > 0) totalWorkMs += workMsThisDay;
            }

            if (validPH) {
                phWorkedDays += isSat ? satMulti : 1; 
                phWorkedMs += (workMsThisDay > 0 ? workMsThisDay : 0); 
            }
        } else {
            if (validPH) {
                const isSat = new Date(dateStr).getDay() === 6;
                phUnworkedDays += isSat ? satMulti : 1;

                if (sched && sched.start && sched.end) {
                    let schedDurMsPH = toDateObj(sched.end, dateStr) - toDateObj(sched.start, dateStr);
                    if (sched.breakMins) schedDurMsPH -= sched.breakMins * 60000;
                    if (schedDurMsPH > 0) phUnworkedMs += schedDurMsPH;
                } else if (leaveType) {
                    phUnworkedMs += 8 * 3600000; 
                }
            } else if (sched && !leaveType) {
                const isSat = new Date(dateStr).getDay() === 6;
                absentDays += isSat ? satMulti : 1;

                if (sched.start && sched.end) {
                    let schedDurMsAbs = toDateObj(sched.end, dateStr) - toDateObj(sched.start, dateStr);
                    if (sched.breakMins) schedDurMsAbs -= sched.breakMins * 60000;
                    if (schedDurMsAbs > 0) absentHrs += (schedDurMsAbs / 3600000);
                }
            }
        }
    }

    let annualLeaveCount = 0, medicalLeaveCount = 0, unpaidLeaveCount = 0;
    let unpaidLeaveHrs = 0;

    for (const [dateStr, leaveObj] of Object.entries(userLeaves)) {
        const lType = leaveObj.type;
        const lVal = parseFloat(leaveObj.val) || 1; 
        
        const validPH = !!holidaysMap[dateStr] && (!!mySchedules[dateStr] || !!lType);
        
        if (!attMap[dateStr]?.in || lVal < 1 || !validPH) {
            if (lType.includes('Annual') || lType.includes('年假') || lType.includes('Cuti Tahunan')) {
                annualLeaveCount += lVal;
            }
            else if (lType.includes('Medical') || lType.includes('病假') || lType.includes('Cuti Sakit')) {
                medicalLeaveCount += lVal;
            }
            else {
                unpaidLeaveCount += lVal; 
                const sched = mySchedules[dateStr];
                if (sched && sched.start && sched.end) {
                    let schedDurMsUnp = toDateObj(sched.end, dateStr) - toDateObj(sched.start, dateStr);
                    if (sched.breakMins) schedDurMsUnp -= sched.breakMins * 60000;
                    if (schedDurMsUnp > 0) {
                        unpaidLeaveHrs += (schedDurMsUnp / 3600000) * lVal; 
                    }
                } else {
                    unpaidLeaveHrs += 8 * lVal; 
                }
            }
        }
    }

    const totalDecimalHrs = totalWorkMs / 3600000;
    const phUnworkedHrsDec = phUnworkedMs / 3600000;
    const phWorkedHrsDec = phWorkedMs / 3600000;
    const formattedTotalHrs = msToHM(totalWorkMs);
    const totalLateMins = Math.floor(totalLateMs / 60000);

    const dayFreq = {}; Object.values(userSchedCounts).forEach(c => dayFreq[c] = (dayFreq[c] || 0) + 1);
    let majorityDays = 26; let maxFreq = 0;
    for (let d in dayFreq) { if (dayFreq[d] > maxFreq) { maxFreq = dayFreq[d]; majorityDays = parseInt(d); } }

    const hrFreq = {}; 
    Object.values(userSchedHours).forEach(h => {
        const key = h.toFixed(1);
        hrFreq[key] = (hrFreq[key] || 0) + 1;
    });

    let majorityHours = 208; let maxHrFreq = 0;
    for (let h in hrFreq) { 
        if (hrFreq[h] > maxHrFreq) { maxHrFreq = hrFreq[h]; majorityHours = parseFloat(h); } 
    }

    const paidLeaveCount = annualLeaveCount + medicalLeaveCount; 
    const fixedScheduledDays = majorityDays; 
    
    const totalRecordedDays = actWorkedDays + paidLeaveCount + phUnworkedDays + unpaidLeaveCount + absentDays;
    const unscheduledDays = Math.max(0, fixedScheduledDays - totalRecordedDays);

    const totalRecordedHrs = totalDecimalHrs + phUnworkedHrsDec + (paidLeaveCount * 8) + unpaidLeaveHrs + absentHrs;
    const unscheduledHrs = Math.max(0, majorityHours - totalRecordedHrs);

    const metaTotalHrsEl = document.getElementById('metaTotalHrs');
    if(metaTotalHrsEl) {
        metaTotalHrsEl.dataset.majorityHours = majorityHours;
        metaTotalHrsEl.value = totalDecimalHrs.toFixed(2);
    }
    
    safeSetVal('inpStdDays', fixedScheduledDays);
    safeSetText('dispSchDays', `${mySchedCount} Days`);
    safeSetText('dispActDays', `${actWorkedDays} Days`);
    safeSetText('dispPaidLeave', `${paidLeaveCount} Days (AL:${annualLeaveCount} ML:${medicalLeaveCount})`);
    safeSetText('dispPH', `${phUnworkedDays} / ${phWorkedDays} Off/Work`);
    safeSetText('dispPayableDays', `${actWorkedDays + paidLeaveCount + phUnworkedDays} Days`);
    safeSetText('dispTotalHrs', `${formattedTotalHrs} / ${majorityHours}h`);
    safeSetText('dispLateStats', `${lateCount} times (${totalLateMins}m)`);

    safeSetText('dispAbsent', `${absentDays} Days`);
    safeSetText('dispUnpaidLeave', `${unpaidLeaveCount} Days`);
    
    safeSetVal('metaUnscheduledDays', unscheduledDays);
    safeSetText('dispUnscheduled', `${unscheduledDays} Days`);

    safeSetVal('metaDaysSch', mySchedCount);
    safeSetVal('metaDaysAct', actWorkedDays);
    safeSetVal('metaLateMins', totalLateMins);
    safeSetVal('metaLateCount', lateCount);
    
    const lateMinsEl = document.getElementById('metaLateMins');
    if (lateMinsEl) {
        lateMinsEl.dataset.fraction = totalLateFraction;
        lateMinsEl.dataset.weekdayFraction = weekdayLateFraction;
        lateMinsEl.dataset.satFraction = satLateFraction;
        lateMinsEl.dataset.weekdayMins = Math.floor(totalWeekdayLateMs / 60000);
        lateMinsEl.dataset.satMins = Math.floor(totalSatLateMs / 60000);
    }

    safeSetVal('metaAnnualLeave', annualLeaveCount);
    safeSetVal('metaMedicalLeave', medicalLeaveCount);
    
    safeSetVal('metaAbsentDays', absentDays);
    safeSetVal('metaAbsentHrs', absentHrs);
    safeSetVal('metaUnpaidLeave', unpaidLeaveCount);
    safeSetVal('metaUnpaidLeaveHrs', unpaidLeaveHrs);
    safeSetVal('metaUnscheduledHrs', unscheduledHrs);

    safeSetVal('metaPHUnworked', phUnworkedDays);
    safeSetVal('metaPHWorked', phWorkedDays);
    safeSetVal('metaPHWorkedHrs', phWorkedHrsDec);
    
    const unworkedPhEl = document.getElementById('metaPHUnworked');
    if (unworkedPhEl) unworkedPhEl.dataset.hrs = phUnworkedHrsDec;
}

window.calcTotals = (updateMode = 'none') => {
    if (updateMode === true) updateMode = 'all';
    if (updateMode === false) updateMode = 'none';

    const autoUpdateAttendance = (updateMode === 'all');
    const autoUpdateStatutory = (updateMode === 'all' || updateMode === 'statutory');

    const getVal = (id) => { const el = document.getElementById(id); return el ? (parseFloat(el.value) || 0) : 0; };
    const fullBasic = getVal('inpBasic');
    let baseGross = fullBasic; 
    
    let phExtraGross = 0, autoLateDeduct = 0;
    let absentDed = 0, unpaidDed = 0, unscheduledDed = 0;

    const lateMins = getVal('metaLateMins');
    const lateCount = getVal('metaLateCount');
    
    const lateMinsEl = document.getElementById('metaLateMins');
    const lateFraction = parseFloat(lateMinsEl?.dataset?.fraction) || 0;
    const weekdayFraction = parseFloat(lateMinsEl?.dataset?.weekdayFraction) || 0;
    const satFraction = parseFloat(lateMinsEl?.dataset?.satFraction) || 0;
    const weekdayMins = parseInt(lateMinsEl?.dataset?.weekdayMins) || 0;
    const satMins = parseInt(lateMinsEl?.dataset?.satMins) || 0;

    const phWorked = getVal('metaPHWorked');
    const phWorkedHrs = getVal('metaPHWorkedHrs');

    const stdDays = getVal('inpStdDays') || 26; 
    const actDays = getVal('metaDaysAct');
    const al = getVal('metaAnnualLeave');
    const ml = getVal('metaMedicalLeave');
    const phOff = getVal('metaPHUnworked');
    const unpaid = getVal('metaUnpaidLeave');
    const absentDays = getVal('metaAbsentDays');
    
    const totalRecDays = actDays + al + ml + phOff + unpaid + absentDays;
    let rawUnschedDays = stdDays - totalRecDays;
    const cleanUnschedDays = rawUnschedDays < 0.05 ? 0 : Number(Math.max(0, rawUnschedDays).toFixed(1));
    
    safeSetVal('metaUnscheduledDays', cleanUnschedDays);
    safeSetText('dispUnscheduled', `${cleanUnschedDays} Days`);

    if (globalSettings.calcMode === 'hourly') {
        const metaTotalHrsEl = document.getElementById('metaTotalHrs');
        const majorityHours = parseFloat(metaTotalHrsEl?.dataset?.majorityHours) || 208;

        let exactHrRate = 0;
        if (fullBasic > 0 && majorityHours > 0) {
            exactHrRate = fullBasic / majorityHours;
            safeSetVal('inpHourlyRate', exactHrRate.toFixed(2));
        }

        const hrRateToUse = exactHrRate;

        absentDed = hrRateToUse * getVal('metaAbsentHrs');
        unpaidDed = hrRateToUse * getVal('metaUnpaidLeaveHrs');
        let rawUnschedDed = hrRateToUse * getVal('metaUnscheduledHrs');

        phExtraGross = hrRateToUse * phWorkedHrs * 2; 

        if (globalSettings.lateMode === 'times') {
            unscheduledDed = rawUnschedDed;
            autoLateDeduct = lateCount * (parseFloat(globalSettings.lateFixedAmount) || 0);
            safeSetText('lateFormulaText', `Fine: ${lateCount} times x RM${globalSettings.lateFixedAmount}`);
        } else {
            const lateHrs = lateMins / 60;
            let calculatedLateDed = lateHrs * hrRateToUse;
            
            if (calculatedLateDed > rawUnschedDed) {
                calculatedLateDed = rawUnschedDed;
            }
            
            autoLateDeduct = calculatedLateDed;
            unscheduledDed = rawUnschedDed - autoLateDeduct;
            safeSetText('lateFormulaText', `Extracted from Pro-rated: ${lateMins} mins`);
        }
        
    } else {
        const exactDailyRate = stdDays > 0 ? (fullBasic / stdDays) : 0;
        
        absentDed = exactDailyRate * absentDays;
        unpaidDed = exactDailyRate * unpaid;
        unscheduledDed = exactDailyRate * cleanUnschedDays;
        
        phExtraGross = phWorked * 2 * exactDailyRate;

        if (globalSettings.lateMode === 'times') {
            autoLateDeduct = lateCount * (parseFloat(globalSettings.lateFixedAmount) || 0);
            safeSetText('lateFormulaText', `Fine: ${lateCount} times x RM${globalSettings.lateFixedAmount}`);
        } else {
            autoLateDeduct = exactDailyRate * lateFraction;
            safeSetText('lateFormulaText', `Dynamic ratio from daily shift: ${lateMins} mins`);
        }
    }
    
    if (autoUpdateAttendance) {
        safeSetVal('inpAbsentDed', absentDed.toFixed(2));
        safeSetVal('inpUnpaidDed', unpaidDed.toFixed(2));
        safeSetVal('inpUnscheduledDed', unscheduledDed.toFixed(2));
        safeSetVal('inpLateDed', autoLateDeduct.toFixed(2));
    }

    safeSetVal('dispGrossBasic', formatMoney(baseGross));
    safeSetVal('calcPHExtra', phExtraGross.toFixed(2));

    let earnedBasicForStatutory = baseGross - getVal('inpAbsentDed') - getVal('inpUnpaidDed') - getVal('inpUnscheduledDed') - getVal('inpLateDed');
    if (earnedBasicForStatutory < 0) earnedBasicForStatutory = 0;

    if (autoUpdateStatutory) {
        const uid = document.getElementById('staffSelect')?.value;
        const staff = staffMap[uid]; 
        
        if (staff && staff.statutory) {
            const epfRaw = staff.statutory.epf?.contrib || '11';
            
            safeSetText('hintEPF', `(${epfRaw}%)`);
            safeSetText('hintSOCSO', '(0.5%)');
            safeSetText('hintEIS', '(0.2%)');
            safeSetText('hintSKBKK', '(0.75%)');

            const comm = getVal('inpComm');
            const allow = getVal('inpAllowance');
            const ot = getVal('inpOT');
            const phPay = getVal('calcPHExtra');

            const stat = calculateMalaysiaStatutory(earnedBasicForStatutory, comm, allow, (ot + phPay), epfRaw);

            safeSetVal('inpEPF', stat.epfEmp.toFixed(2));
            safeSetVal('inpSOCSO', stat.socsoEmp.toFixed(2));
            safeSetVal('inpEIS', stat.eisEmp.toFixed(2));
            safeSetVal('inpSKBKK', stat.skbkkEmp.toFixed(2));
            
            safeSetVal('inpEmpEPF', stat.epfEmpr.toFixed(2));
            safeSetVal('inpEmpSOCSO', stat.socsoEmpr.toFixed(2));
            safeSetVal('inpEmpEIS', stat.eisEmpr.toFixed(2));
        } else {
            safeSetText('hintEPF', ''); safeSetText('hintSOCSO', ''); safeSetText('hintEIS', ''); safeSetText('hintSKBKK', '');
        }
    }

    const grossTotal = baseGross + phExtraGross + getVal('inpComm') + getVal('inpOT') + getVal('inpAllowance') + getVal('inpReimbursement');
    const totalDed = getVal('inpAbsentDed') + getVal('inpUnpaidDed') + getVal('inpUnscheduledDed') + getVal('inpEPF') + getVal('inpSOCSO') + getVal('inpEIS') + getVal('inpSKBKK') + getVal('inpPCB') + getVal('inpLateDed') + getVal('inpAdvance'); 
    const finalNet = grossTotal - totalDed;
    
    safeSetText('dispNet', "RM " + formatMoney(finalNet));
};

window.savePayslipForm = async () => {
    const uid = document.getElementById('staffSelect')?.value;
    const month = document.getElementById('formMonthPicker')?.value;
    if(!uid || !month) return showStatusAlert('statusMessage', "Select staff and month", false);

    showLoading();
    const staff = staffMap[uid];
    
    // --- MODIFIED LOGIC: Flag if terminated this month ---
    const termDate = staff?.employment?.termDate;
    const isTerminatedThisMonth = termDate && termDate.startsWith(month);
    // -----------------------------------------------------

    const getVal = (id) => { const el = document.getElementById(id); return el ? (parseFloat(el.value) || 0) : 0; };
    const status = document.getElementById('formStatus')?.value || 'Draft';
    
    const baseGross = parseFloat(document.getElementById('dispGrossBasic')?.value.replace(/,/g,'')) || 0;
    const phExtraGross = getVal('calcPHExtra');

    const grossTotal = baseGross + phExtraGross + getVal('inpComm') + getVal('inpOT') + getVal('inpAllowance') + getVal('inpReimbursement');
    const totalDed = getVal('inpAbsentDed') + getVal('inpUnpaidDed') + getVal('inpUnscheduledDed') + getVal('inpEPF') + getVal('inpSOCSO') + getVal('inpEIS') + getVal('inpSKBKK') + getVal('inpPCB') + getVal('inpLateDed') + getVal('inpAdvance');
    const net = grossTotal - totalDed;

    const payload = {
        uid: uid, 
        authUid: staff ? staff.authUid : null,
        month,
        endDate: isTerminatedThisMonth ? termDate : null, // MODIFIED: Save to database
        companyName: document.getElementById('inpCompany')?.value || 'RH RIDER HUB MOTOR (M) SDN. BHD.',
        staffName: staff ? staff.displayName : 'Unknown',
        staffCode: staff ? staff.displayId : '',
        icNo: staff?.personal?.icNo || '-',
        epfNo: staff?.statutory?.epf?.no || '-',
        socsoNo: staff?.statutory?.socso?.no || '-',
        department: staff?.employment?.dept || '-',
        bankAcc: staff?.payroll?.bank1?.acc || '-',
        bankName: staff?.payroll?.bank1?.name || '-',
        joinDate: staff?.employment?.joinDate || null,
        basic: getVal('inpBasic'),
        final_basic: baseGross, 
        earnings: { commission: getVal('inpComm'), ot: getVal('inpOT'), allowance: getVal('inpAllowance'), reimbursement: getVal('inpReimbursement'), phPay: phExtraGross, total: grossTotal },
        deductions: { 
            absent: getVal('inpAbsentDed'), 
            unpaidLeave: getVal('inpUnpaidDed'), 
            unscheduled: getVal('inpUnscheduledDed'), 
            epf: getVal('inpEPF'), 
            socso: getVal('inpSOCSO'), 
            eis: getVal('inpEIS'), 
            skbkk: getVal('inpSKBKK'),
            tax: getVal('inpPCB'), 
            late: getVal('inpLateDed'), 
            advance: getVal('inpAdvance'), 
            total: totalDed 
        },
        employer_epf: getVal('inpEmpEPF'), employer_socso: getVal('inpEmpSOCSO'), employer_eis: getVal('inpEmpEIS'),
        attendanceStats: {
            stdDays: getVal('inpStdDays'), 
            actDays: getVal('metaDaysAct'),
            annualLeave: getVal('metaAnnualLeave'),
            medicalLeave: getVal('metaMedicalLeave'),
            unpaidLeave: getVal('metaUnpaidLeave'),
            absentDays: getVal('metaAbsentDays'),
            unscheduledDays: getVal('metaUnscheduledDays'),
            phUnworked: getVal('metaPHUnworked'),
            phWorked: getVal('metaPHWorked'),
            phUnworkedHrs: parseFloat(document.getElementById('metaPHUnworked')?.dataset?.hrs) || 0,
            totalHrs: getVal('metaTotalHrs'),
            lateMins: getVal('metaLateMins'), 
            lateCount: getVal('metaLateCount'), 
            lateFraction: parseFloat(document.getElementById('metaLateMins')?.dataset?.fraction) || 0,
            weekdayLateFraction: parseFloat(document.getElementById('metaLateMins')?.dataset?.weekdayFraction) || 0,
            satLateFraction: parseFloat(document.getElementById('metaLateMins')?.dataset?.satFraction) || 0,
            weekdayLateMins: parseInt(document.getElementById('metaLateMins')?.dataset?.weekdayMins) || 0,
            satLateMins: parseInt(document.getElementById('metaLateMins')?.dataset?.satMins) || 0,
            mode: globalSettings.calcMode,
            majorityHours: parseFloat(document.getElementById('metaTotalHrs')?.dataset?.majorityHours) || 208
        },
        gross: grossTotal, net: net, status: status,
        updatedAt: serverTimestamp()
    };

    const oldDocId = document.getElementById('editDocId')?.value;
    const payslipId = oldDocId ? oldDocId : `${uid}_${month}_${Date.now()}`;
    try {
        const psRef = doc(db, "payslips", payslipId);
        const oldSnap = await getDoc(psRef);
        const isExisting = oldSnap.exists();
        const oldData = isExisting ? oldSnap.data() : null;

        let actionType = oldDocId ? "EDIT_PAYSLIP" : "CREATE_PAYSLIP";

        payload.createdAt = isExisting ? oldData.createdAt : serverTimestamp();

        await setDoc(psRef, payload);

        if (status === 'Published' && getVal('inpAdvance') > 0) {
            const rawIds = document.getElementById('pendingAdvanceIds')?.value;
            if (rawIds) {
                const advIds = JSON.parse(rawIds);
                const batch = writeBatch(db);
                advIds.forEach(advId => {
                    batch.update(doc(db, "salary_advances", advId), { isDeducted: true, deductedInMonth: month, deductedAt: serverTimestamp() });
                });
                await batch.commit();
            }
        }

        await logAdminAction(db, auth.currentUser, actionType, uid, oldData, payload);

        if (window.currentViewingPayslipId) {
            showStatusAlert('statusMessage', 'Saved! Moving to next...', true);
            window.navigatePayslip(1); 
        } else {
            if(formModal) formModal.hide();
            showStatusAlert('statusMessage', 'Payslip saved successfully.', true); 
        }
        
        window.loadPayroll();
    } catch(e) { 
        hideLoading();
        showStatusAlert('statusMessage', "Save error: " + e.message, false); 
    }
};

window.loadPayroll = async () => {
    const month = document.getElementById('globalMonthPicker')?.value;
    if(!month) return;
    showLoading(); 
    const listDiv = document.getElementById('payrollList');
    if(!listDiv) return;
    listDiv.innerHTML = '';
    
    try {
        const q = query(collection(db, "payslips"), where("month", "==", month));
        const snap = await getDocs(q);
        currentPayrollData = [];
        let totalNet = 0; let totalEmpEPF = 0;

        if (snap.empty) {
            listDiv.innerHTML = `<div class="text-center py-5 text-muted fw-bold">No payslips found for ${month}.</div>`;
            safeSetText('statTotal', "RM 0.00"); safeSetText('statEPF', "RM 0.00");
            return; 
        }

        snap.forEach(doc => {
            const d = doc.data(); d.id = doc.id;
            currentPayrollData.push(d);
            totalNet += (d.net || 0); totalEmpEPF += (d.employer_epf || 0);

            const displayName = staffMap[d.uid] ? staffMap[d.uid].displayName : d.staffName;
            const modeText = d.attendanceStats?.mode === 'hourly' ? '⌚ Hourly' : '📅 Daily';
            const termIndicator = d.endDate ? `<span class="badge bg-danger ms-1" style="font-size:10px;">FINAL PAY</span>` : '';
            
            const row = document.createElement('div');
            row.className = `row align-items-center py-3 border-bottom px-3 bg-white status-${d.status} hover-bg-light`;
            row.innerHTML = `
                <div class="col-3">
                    <div class="fw-bold text-primary" style="cursor:pointer" onclick="window.openEditModal('${d.id}')">${displayName} ${termIndicator}</div>
                    <small class="text-muted">${modeText}</small>
                </div>
                <div class="col-2 text-primary fw-bold">RM ${formatMoney(d.final_basic || d.basic)}</div>
                <div class="col-2 text-danger">RM ${formatMoney(d.deductions?.total || 0)}</div>
                <div class="col-2 fw-bold fs-5">RM ${formatMoney(d.net)}</div>
                <div class="col-1"><span class="badge ${d.status === 'Published' ? 'bg-success' : 'bg-warning text-dark'} px-2 py-1">${d.status}</span></div>
                <div class="col-2 text-end">
                    <button class="btn btn-sm btn-light border me-1" onclick="window.openEditModal('${d.id}')" title="Edit"><i data-lucide="edit-2" class="size-4"></i></button>
                    <button class="btn btn-sm btn-outline-dark" onclick="window.viewPayslip('${d.id}')" title="Print/View"><i data-lucide="printer" class="size-4"></i></button>
                </div>
            `;
            listDiv.appendChild(row);
        });

        safeSetText('statTotal', "RM " + formatMoney(totalNet));
        safeSetText('statEPF', "RM " + formatMoney(totalEmpEPF));
        lucide.createIcons();
    } catch (e) { console.error(e); } 
    finally { hideLoading(); }
};

window.openCreateModal = () => {
    window.currentViewingPayslipId = null;
    const navGroup = document.getElementById('navPayslipGroup');
    if (navGroup) navGroup.style.display = 'none';

    document.getElementById('payslipForm')?.reset();
    
    safeSetVal('editDocId', "");
    safeSetVal('pendingAdvanceIds', "");
    safeSetText('formModalTitle', "Create New Payslip");
    const termBadge = document.getElementById('termBadge');
    if (termBadge) termBadge.classList.add('d-none');
    
    const staffSelect = document.getElementById('staffSelect');
    const formMonthPicker = document.getElementById('formMonthPicker');
    if (staffSelect) staffSelect.disabled = false;
    if (formMonthPicker) formMonthPicker.disabled = false;
    
    safeSetText('dispNet', "RM 0.00");
    safeSetVal('dispGrossBasic', "0.00");
    safeSetVal('calcPHExtra', "0");
    safeSetText('hintEPF', "");
    safeSetText('hintEIS', "");
    safeSetText('hintSKBKK', "");
    safeSetVal('inpCompany', globalSettings.defaultCompany || 'RH RIDER HUB MOTOR (M) SDN. BHD.');

    document.getElementById('btnDeletePayslip')?.classList.add('d-none');

    const globalDate = document.getElementById('globalMonthPicker')?.value;
    if(globalDate) safeSetVal('formMonthPicker', globalDate);

    window.toggleSettingsView(); 
    if(formModal) formModal.show();
};

window.openEditModal = (id) => {
    const d = currentPayrollData.find(x => x.id === id);
    if(!d) return;

    window.currentViewingPayslipId = id;
    const navGroup = document.getElementById('navPayslipGroup');
    if (navGroup) navGroup.style.display = 'inline-flex';

    safeSetVal('editDocId', id);
    safeSetText('formModalTitle', "Edit Payslip - " + d.staffName);
    const termBadge = document.getElementById('termBadge');
    if (termBadge) termBadge.classList.toggle('d-none', !d.endDate);
    
    const staffSelect = document.getElementById('staffSelect');
    const formMonthPicker = document.getElementById('formMonthPicker');
    if (staffSelect) { staffSelect.value = d.uid; staffSelect.disabled = true; }
    if (formMonthPicker) { formMonthPicker.value = d.month; formMonthPicker.disabled = true; }

    safeSetVal('inpCompany', d.companyName || globalSettings.defaultCompany || 'RH RIDER HUB MOTOR (M) SDN. BHD.');

    safeSetVal('inpBasic', d.basic);
    safeSetVal('calcPHExtra', d.earnings.phPay || 0);
    safeSetVal('inpComm', d.earnings.commission || 0);
    safeSetVal('inpOT', d.earnings.ot || 0);
    safeSetVal('inpAllowance', d.earnings.allowance || 0);
    safeSetVal('inpReimbursement', d.earnings.reimbursement || 0);

    safeSetVal('inpAbsentDed', d.deductions?.absent || 0);
    safeSetVal('inpUnpaidDed', d.deductions?.unpaidLeave || 0);
    safeSetVal('inpUnscheduledDed', d.deductions?.unscheduled || 0);
    
    safeSetVal('inpEPF', d.deductions.epf || 0);
    safeSetVal('inpSOCSO', d.deductions.socso || 0);
    safeSetVal('inpEIS', d.deductions.eis || 0);
    safeSetVal('inpSKBKK', d.deductions.skbkk || 0);
    safeSetVal('inpPCB', d.deductions.tax || 0);
    safeSetVal('inpLateDed', d.deductions.late || 0);
    safeSetVal('inpAdvance', d.deductions.advance || 0); 

    safeSetVal('inpEmpEPF', d.employer_epf || 0);
    safeSetVal('inpEmpSOCSO', d.employer_socso || 0);
    safeSetVal('inpEmpEIS', d.employer_eis || 0);

    safeSetVal('formStatus', d.status || 'Draft');

    document.getElementById('btnDeletePayslip')?.classList.remove('d-none');
    
    const staff = staffMap[d.uid];
    if (staff && staff.statutory) {
        const epfRaw = staff.statutory.epf?.contrib || '';
        const eisRaw = staff.statutory.eis || '';
        safeSetText('hintEPF', epfRaw ? `(${epfRaw}${epfRaw.toString().includes('%') ? '' : '%'})` : '');
        safeSetText('hintEIS', eisRaw ? `(${eisRaw}${eisRaw.toString().includes('%') ? '' : '%'})` : '');
        safeSetText('hintSKBKK', '(0.75%)');
    }
    
    if (d.attendanceStats) {
        safeSetVal('inpStdDays', d.attendanceStats.stdDays || 26);
        safeSetVal('metaDaysAct', d.attendanceStats.actDays || 0);
        
        safeSetVal('metaAnnualLeave', d.attendanceStats.annualLeave || 0);
        safeSetVal('metaMedicalLeave', d.attendanceStats.medicalLeave || 0);
        
        safeSetVal('metaAbsentDays', d.attendanceStats.absentDays || 0);
        safeSetVal('metaUnpaidLeave', d.attendanceStats.unpaidLeave || 0);
        
        safeSetVal('metaUnscheduledDays', d.attendanceStats.unscheduledDays || 0);

        safeSetVal('metaPHUnworked', d.attendanceStats.phUnworked || 0);
        safeSetVal('metaPHWorked', d.attendanceStats.phWorked || 0);
        
        const al = parseFloat(d.attendanceStats.annualLeave) || 0;
        const ml = parseFloat(d.attendanceStats.medicalLeave) || 0;
        const totalPaidLeave = al + ml;

        const phOff = parseFloat(d.attendanceStats.phUnworked) || 0;
        const phWork = parseFloat(d.attendanceStats.phWorked) || 0;
        
        safeSetText('dispPaidLeave', `${totalPaidLeave} <span style="font-size:0.6rem">Days (AL:${al} ML:${ml})</span>`);
        safeSetText('dispActDays', `${d.attendanceStats.actDays || 0} <span style="font-size:0.6rem">Days</span>`);
        safeSetText('dispPH', `${phOff} / ${phWork} <span style="font-size:0.6rem">Off/Work</span>`);
        safeSetText('dispPayableDays', `${parseFloat(d.attendanceStats.actDays || 0) + totalPaidLeave + phOff} <span style="font-size:0.6rem">Days</span>`);

        safeSetText('dispAbsent', `${d.attendanceStats.absentDays || 0} <span style="font-size:0.6rem">Days</span>`);
        safeSetText('dispUnpaidLeave', `${d.attendanceStats.unpaidLeave || 0} <span style="font-size:0.6rem">Days</span>`);
        
        safeSetText('dispUnscheduled', `${d.attendanceStats.unscheduledDays || 0} <span style="font-size:0.6rem">Days</span>`);

        safeSetVal('metaTotalHrs', d.attendanceStats.totalHrs || 0);
        
        const unworkedPhEl = document.getElementById('metaPHUnworked');
        if (unworkedPhEl && d.attendanceStats.phUnworkedHrs !== undefined) {
            unworkedPhEl.dataset.hrs = d.attendanceStats.phUnworkedHrs;
        }
        const metaTotalHrsEl = document.getElementById('metaTotalHrs');
        if (metaTotalHrsEl && d.attendanceStats.majorityHours !== undefined) {
            metaTotalHrsEl.dataset.majorityHours = d.attendanceStats.majorityHours;
        }

        safeSetVal('metaLateMins', d.attendanceStats.lateMins || 0);
        safeSetVal('metaLateCount', d.attendanceStats.lateCount || 0);
        
        const lateMinsEl = document.getElementById('metaLateMins');
        if (lateMinsEl) {
            lateMinsEl.dataset.fraction = d.attendanceStats.lateFraction || 0;
            lateMinsEl.dataset.weekdayFraction = d.attendanceStats.weekdayLateFraction || 0;
            lateMinsEl.dataset.satFraction = d.attendanceStats.satLateFraction || 0;
            lateMinsEl.dataset.weekdayMins = d.attendanceStats.weekdayLateMins || 0;
            lateMinsEl.dataset.satMins = d.attendanceStats.satLateMins || 0;
        }

        const savedTotalHrs = parseFloat(d.attendanceStats.totalHrs) || 0;
        const hrPart = Math.floor(savedTotalHrs);
        const minPart = Math.round((savedTotalHrs - hrPart) * 60);
        
        const majHrs = d.attendanceStats.majorityHours || 208;
        safeSetText('dispTotalHrs', `${hrPart}h ${minPart}m / ${majHrs}h`);
        
        safeSetText('dispLateStats', `${d.attendanceStats.lateCount || 0} <span style="font-size:0.6rem">times (${d.attendanceStats.lateMins || 0}m)</span>`);
        
        // 🟢 载入时不覆盖任何扣款
        window.calcTotals('none');
    }
    if(formModal) formModal.show();
};

window.viewPayslip = (id) => {
    const d = currentPayrollData.find(x => x.id === id);
    if(!d) return;

    window.currentPrintTitle = `${d.month} Payslip-${d.staffCode || 'NoID'} ${d.staffName}`;

    const stats = d.attendanceStats || {};
    const al = parseFloat(stats.annualLeave) || 0;
    const ml = parseFloat(stats.medicalLeave) || 0;
    const ul = parseFloat(stats.unpaidLeave) || 0;
    const abs = parseFloat(stats.absentDays) || 0;
    const unsched = parseFloat(stats.unscheduledDays) || 0;
    const phUnworked = parseFloat(stats.phUnworked) || 0;
    const phWorked = parseFloat(stats.phWorked) || 0;
    const actDays = parseFloat(stats.actDays) || 0;
    const stdDays = parseFloat(stats.stdDays) || 26;
    const lateMins = parseFloat(stats.lateMins) || 0;
    const lateCount = parseInt(stats.lateCount) || 0;

    let payPeriodDisplay = d.month;
    if (d.month && d.month.includes('-')) {
        const [year, mth] = d.month.split('-');
        let lastDay = new Date(year, mth, 0).getDate();
        let startDay = "01";
        
        // --- MODIFIED LOGIC: Override last day if terminated ---
        if (d.endDate) {
            const endParts = d.endDate.split('-');
            if(endParts.length === 3) lastDay = endParts[2];
        }
        // -------------------------------------------------------
        
        const jDate = d.joinDate || staffMap[d.uid]?.employment?.joinDate;
        if (jDate) {
            if (jDate.includes(`${year}-${mth}`)) {
                const parts = jDate.split('-');
                if(parts.length === 3) startDay = parts[2].padStart(2, '0');
            } else if (jDate.includes(`${mth}/${year}`) || jDate.includes(`${mth}-${year}`)) {
                const parts = jDate.includes('/') ? jDate.split('/') : jDate.split('-');
                if(parts.length === 3) startDay = parts[0].padStart(2, '0');
            }
        }
        payPeriodDisplay = `${startDay}/${mth}/${year} - ${lastDay}/${mth}/${year}`;
    }

    const earningsList = [];
    const deductionsList = [];

    earningsList.push({ name: 'BASIC PAY', amount: parseFloat(d.basic) || 0 });
    
    if (d.earnings.phPay > 0) earningsList.push({ name: 'PUBLIC HOLIDAY PAY (EXTRA 2x)', amount: d.earnings.phPay });
    if (d.earnings.commission > 0) earningsList.push({ name: 'COMMISSION', amount: d.earnings.commission });
    if (d.earnings.ot > 0) earningsList.push({ name: 'OVERTIME', amount: d.earnings.ot });
    if (d.earnings.allowance > 0) earningsList.push({ name: 'ALLOWANCE', amount: d.earnings.allowance });
    if (d.earnings.reimbursement > 0) earningsList.push({ name: 'REIMBURSEMENT', amount: d.earnings.reimbursement });

    if (d.deductions.absent > 0) {
        const rate = abs > 0 ? (d.deductions.absent / abs).toFixed(2) : "0.00";
        deductionsList.push({ name: `ABSENT - ${abs.toFixed(2)} Days @ RM ${rate}`, amount: d.deductions.absent });
    }
    if (d.deductions.unpaidLeave > 0) {
        const rate = ul > 0 ? (d.deductions.unpaidLeave / ul).toFixed(2) : "0.00";
        deductionsList.push({ name: `UNPAID LEAVE - ${ul.toFixed(2)} Days @ RM ${rate}`, amount: d.deductions.unpaidLeave });
    }
    if (d.deductions.unscheduled > 0) {
        const rate = unsched > 0 ? (d.deductions.unscheduled / unsched).toFixed(2) : "0.00";
        deductionsList.push({ name: `PRO-RATED / UNSCHEDULED - ${unsched.toFixed(2)} Days @ RM ${rate}`, amount: d.deductions.unscheduled });
    }

    if (d.deductions.late > 0) {
        let lateStr = "LATENESS";
        if (stats.mode === 'times' || (lateCount > 0 && lateMins === 0)) {
            const perTime = lateCount > 0 ? (d.deductions.late / lateCount).toFixed(2) : "0.00";
            lateStr = `LATENESS - ${lateCount} Times @ RM ${perTime}`;
        } else if (lateMins > 0) {
            const lateHrs = (lateMins / 60);
            const rate = lateHrs > 0 ? (d.deductions.late / lateHrs).toFixed(2) : "0.00";
            lateStr = `LATENESS - ${lateHrs.toFixed(2)} Hours @ RM ${rate}/hr`;
        }
        deductionsList.push({ name: lateStr, amount: d.deductions.late });
    }

    if (d.deductions.epf > 0) deductionsList.push({ name: 'EPF (Employee)', amount: d.deductions.epf });
    if (d.deductions.socso > 0) deductionsList.push({ name: 'SOCSO (Employee)', amount: d.deductions.socso });
    if (d.deductions.eis > 0) deductionsList.push({ name: 'EIS (Employee)', amount: d.deductions.eis });
    if (d.deductions.skbkk > 0) deductionsList.push({ name: 'SKBKK (Employee)', amount: d.deductions.skbkk });
    if (d.deductions.tax > 0) deductionsList.push({ name: 'PCB / TAX', amount: d.deductions.tax });
    if (d.deductions.advance > 0) deductionsList.push({ name: 'SALARY ADVANCE', amount: d.deductions.advance });

    let tableRows = '';
    const maxRows = Math.max(earningsList.length, deductionsList.length);
    let visualGross = 0;
    let visualDed = 0;

    for(let i = 0; i < maxRows; i++) {
        const earn = earningsList[i] || { name: '', amount: null };
        const ded = deductionsList[i] || { name: '', amount: null };

        if (earn.amount !== null) visualGross += earn.amount;
        if (ded.amount !== null) visualDed += ded.amount;

        let earnNameHtml = earn.amount !== null ? earn.name : '';
        let earnAmtHtml = earn.amount !== null ? formatMoney(earn.amount) : '';
        let dedNameHtml = ded.amount !== null ? ded.name : '';
        let dedAmtHtml = ded.amount !== null ? formatMoney(ded.amount) : '';

        let dedStyle = 'padding-left:20px;';
        let dedAmtStyle = 'text-align:right;';
        if (ded.name.includes('LATENESS') || ded.name.includes('ADVANCE') || ded.name.includes('ABSENT') || ded.name.includes('UNPAID') || ded.name.includes('PRO-RATED')) {
            dedStyle += ' color:red;';
            dedAmtStyle += ' color:red;';
        }

        let earnStyle = '';
        let earnAmtStyle = 'text-align:right;';
        if (earn.name.includes('PUBLIC HOLIDAY')) {
            earnStyle += ' color:#f59e0b; font-weight:bold;';
            earnAmtStyle += ' color:#f59e0b; font-weight:bold;';
        }

        tableRows += `
            <tr>
                <td style="${earnStyle}">${earnNameHtml}</td>
                <td style="${earnAmtStyle}">${earnAmtHtml}</td>
                <td style="${dedStyle}">${dedNameHtml}</td>
                <td style="${dedAmtStyle}">${dedAmtHtml}</td>
            </tr>
        `;
    }

    const payableDays = actDays + al + ml + phUnworked;
    const compName = d.companyName || globalSettings.defaultCompany || "RH RIDER HUB MOTOR (M) SDN. BHD.";

    let letterheadSrc = "";
    if (compName === "RH RIDER HUB MOTOR (M) SDN. BHD.") {
        letterheadSrc = "assets/images/Header_RH_RIDER_HUB_MOTOR(M).jpeg"; 
    } else if (compName === "H DIGITAL MARKETING SDN BHD") {
        letterheadSrc = "assets/images/Header_H_DIGITAL_CARRIER_MARKETING.jpeg";
    } else {
        letterheadSrc = "assets/images/Header_RH_RIDER_HUB_MOTOR(BORNEO).jpeg"; 
    }

    let headerBadge = d.endDate ? `<span style="color:#dc2626; border:1px solid #dc2626; padding:1px 6px; border-radius:10px; font-size:10px; margin-left:6px; vertical-align:middle;">FINAL PAY</span>` : '';

    const html = `
        <div class="payslip-preview bg-white shadow-sm border rounded">
            
            <div class="payslip-header border-bottom border-dark pb-3 mb-3 text-center">
                <img src="${letterheadSrc}" alt="${compName} Letterhead" style="width: 100%; max-height: 140px; object-fit: contain;">
            </div>

            <div class="info-grid bg-light p-3 rounded mb-3 border">
                <div>
                    <div class="info-row"><span>Employee Name</span> <span class="fw-bold">: ${d.staffName} ${headerBadge}</span></div>
                    <div class="info-row"><span>Department</span> <span>: ${d.department}</span></div>
                    <div class="info-row"><span>Employee Code</span> <span>: ${d.staffCode}</span></div>
                    <div class="info-row mt-1 pt-1 border-top border-secondary border-opacity-25"><span>Bank Acc</span> <span class="fw-bold">: ${d.bankAcc || '-'} (${d.bankName || '-'})</span></div>
                </div>
                <div>
                    <div class="info-row"><span>IC Number</span> <span>: ${d.icNo}</span></div>
                    <div class="info-row"><span>EPF Number</span> <span>: ${d.epfNo}</span></div>
                    <div class="info-row"><span>SOCSO Number</span> <span>: ${d.socsoNo}</span></div>
                    <div class="info-row mt-1 pt-1 border-top border-secondary border-opacity-25 text-primary fw-bold"><span>Pay Period</span> <span>: ${payPeriodDisplay}</span></div>
                </div>
            </div>

            <table class="finance-table">
                <thead class="bg-light">
                    <tr><th style="width:35%">EARNINGS</th><th style="text-align:right">AMOUNT</th><th style="width:35%; padding-left:20px;">DEDUCTIONS</th><th style="text-align:right">AMOUNT</th></tr>
                </thead>
                <tbody>
                    ${tableRows}
                    <tr class="border-top border-dark">
                        <td style="font-weight:bold; padding-top:10px;">Total Earnings</td><td style="text-align:right; font-weight:bold; padding-top:10px; color:#2563eb;">${formatMoney(visualGross)}</td>
                        <td style="padding-left:20px; font-weight:bold; padding-top:10px;">Total Deductions</td><td style="text-align:right; font-weight:bold; padding-top:10px; color:#dc2626;">${formatMoney(visualDed)}</td>
                    </tr>
                </tbody>
            </table>

            <div class="total-section d-flex justify-content-between align-items-center mt-4 bg-light p-3 rounded border">
                <div class="small text-muted">
                    <div>Employer EPF: <b>RM ${formatMoney(d.employer_epf)}</b></div>
                    <div>Employer SOCSO: <b>RM ${formatMoney(d.employer_socso)}</b></div>
                    <div>Employer EIS: <b>RM ${formatMoney(d.employer_eis)}</b></div>
                </div>
                <div class="text-end">
                    <div class="text-muted text-uppercase fw-bold" style="font-size:0.7rem; letter-spacing:1px;">Net Pay / Actual Salary</div>
                    <div class="text-dark" style="font-size:1.6rem; font-weight:900;">RM ${formatMoney(d.net)}</div>
                </div>
            </div>
            
            <div style="margin-top:20px; font-size:0.75rem; border:1px dashed #ccc; padding:10px; border-radius:6px; color:#64748b;">
                <b>Attendance Stats:</b> Payable Days: ${payableDays} / ${stats.stdDays || 26} (Worked: ${actDays}, AL: ${al}, ML: ${ml}, PH Off: ${phUnworked}, PH Worked: ${phWorked})
                <br><b>Deduction Stats:</b> Absent: ${abs} Days | Unpaid: ${ul} Days | Unscheduled: ${unsched} Days | Late: ${stats.lateCount || 0} times (${stats.lateMins || 0} minutes)
            </div>
        </div>
    `;
    document.getElementById('printArea').innerHTML = html;
    if(printModal) printModal.show();
};
window.printPayslip = () => {
    const originalTitle = document.title;
    document.title = window.currentPrintTitle || 'Payslip';
    window.print();
    setTimeout(() => { 
        document.title = originalTitle; 
    }, 1000);
};

window.publishAll = async () => {
    const drafts = currentPayrollData.filter(d => d.status === 'Draft');
    if(drafts.length === 0) return showStatusAlert('statusMessage', "No draft payslips found to publish.", false);
    
    if(!confirm(`Are you sure you want to officially publish ${drafts.length} payslip(s)?\n\nThis will make them visible to staff and PERMANENTLY deduct their approved Salary Advances.`)) return;
    
    showLoading(); 
    const month = document.getElementById('globalMonthPicker').value;

    try {
        await runTransaction(db, async (transaction) => {
            const advanceRefsToUpdate = [];
            for (const d of drafts) {
                if (d.deductions?.advance > 0) {
                    const targetIds = [d.uid];
                    if(staffMap[d.uid]?.authUid) targetIds.push(staffMap[d.uid].authUid);
                    
                    const advSnap = await getDocs(query(collection(db, "salary_advances"), where("uid", "in", targetIds), where("status", "==", "Approved")));
                    advSnap.forEach(advDoc => {
                        if (!advDoc.data().isDeducted) {
                            advanceRefsToUpdate.push(advDoc.ref);
                        }
                    });
                }
            }

            drafts.forEach(d => {
                const psRef = doc(db, "payslips", d.id);
                transaction.update(psRef, { status: 'Published', publishedAt: serverTimestamp() });
            });

            advanceRefsToUpdate.forEach(ref => {
                transaction.update(ref, { isDeducted: true, deductedInMonth: month, deductedAt: serverTimestamp() });
            });
        });

        await logAdminAction(db, auth.currentUser, "BULK_PUBLISH_PAYSLIPS", "MULTIPLE", null, { count: drafts.length, month: month });

        hideLoading();
        showStatusAlert('statusMessage', `Successfully published ${drafts.length} payslips!`, true);
        window.loadPayroll();

    } catch (e) { 
        hideLoading();
        console.error(e);
        showStatusAlert('statusMessage', "Publish Failed: " + e.message, false); 
    } 
};

// ==========================================
// 4. BATCH GENERATOR ENGINE (AUTO GENERATE ALL)
// ==========================================
window.generateAllDrafts = async () => {
    const monthStr = document.getElementById('globalMonthPicker').value;
    if(!monthStr) return showStatusAlert('statusMessage', "Please select a month first.", false);
    
    if(!confirm(`⚠️ AUTO GENERATION WARNING\n\nThis will automatically calculate and generate DRAFT payslips for ALL active staff for ${monthStr} based on their attendance, leaves, schedules, and advances.\n\nAny existing 'Draft' for this month will be OVERWRITTEN.\nExisting 'Published' payslips will be SKIPPED.\n\nProceed?`)) return;

    showLoading();
    document.getElementById('loadingText').innerText = "Processing automated payroll batch...";

    try {
        const batch = writeBatch(db);
        let generatedCount = 0;
        let skippedCount = 0;

        const [year, month] = monthStr.split('-');
        const startDate = `${monthStr}-01`;
        const daysInMonth = new Date(year, month, 0).getDate();
        const endDate = `${monthStr}-${daysInMonth}`;

        const [allSchedSnap, allLeavesSnap, allAttSnap, allAdvSnap] = await Promise.all([
            getDocs(query(collection(db, "schedules"), where("date", ">=", startDate), where("date", "<=", endDate))),
            getDocs(query(collection(db, "leaves"), where("status", "==", "Approved"))),
            getDocs(query(collection(db, "attendance"), where("date", ">=", startDate), where("date", "<=", endDate))),
            getDocs(query(collection(db, "salary_advances"), where("status", "==", "Approved"), where("isDeducted", "==", false)))
        ]);

        const schedules = {}; const leaves = []; const attendances = {}; const advances = {};
        
        const userSchedHours = {};
        allSchedSnap.forEach(d => { 
            const s = d.data(); 
            if(!schedules[s.userId]) schedules[s.userId] = []; 
            schedules[s.userId].push(s); 
            
            if(s.start && s.end) {
                const start = s.start.toDate ? s.start.toDate() : new Date(s.start);
                const end = s.end.toDate ? s.end.toDate() : new Date(s.end);
                let duration = (end - start) / 3600000;
                duration -= (s.breakMins || 0) / 60;
                if (duration > 0) userSchedHours[s.userId] = (userSchedHours[s.userId] || 0) + duration;
            }
        });

        const hrFreq = {}; 
        Object.values(userSchedHours).forEach(h => {
            const key = h.toFixed(1);
            if (h > 0) hrFreq[key] = (hrFreq[key] || 0) + 1;
        });

        let majorityHours = 208; let maxHrFreq = 0;
        for (let h in hrFreq) { 
            if (hrFreq[h] > maxHrFreq) { maxHrFreq = hrFreq[h]; majorityHours = parseFloat(h); } 
        }

        allLeavesSnap.forEach(d => leaves.push(d.data()));
        allAttSnap.forEach(d => { 
            const a = d.data(); 
            if(a.verificationStatus === 'Verified') {
                if(!attendances[a.uid]) attendances[a.uid] = {};
                if(!attendances[a.uid][a.date]) attendances[a.uid][a.date] = { in: null, out: null, breakOut: null, breakIn: null };
                if(a.session === 'Clock In') attendances[a.uid][a.date].in = a.manualIn || a.timeIn || a.timestamp;
                if(a.session === 'Clock Out') attendances[a.uid][a.date].out = a.manualOut || a.timeOut || a.timestamp;
                if(a.session === 'Break Out') attendances[a.uid][a.date].breakOut = a.manualOut || a.timeOut || a.timestamp;
                if(a.session === 'Break In') attendances[a.uid][a.date].breakIn = a.manualIn || a.timeIn || a.timestamp;
            }
        });
        allAdvSnap.forEach(d => { 
            if (d.data().isTransferred === true) advances[d.data().uid] = (advances[d.data().uid] || 0) + d.data().amount; 
        });

        for (const [uid, staff] of Object.entries(staffMap)) {
            // 🟢 在批量生成时，同样使用包含时间戳的唯一 ID
            const payslipId = `${uid}_${monthStr}_${Date.now()}`;
            
            // 这里为了防止无限生成，我们可以保留一个小检查：如果本月已有一张 Published，则跳过
            const existingPs = currentPayrollData.find(p => p.uid === uid && p.month === monthStr && p.status === 'Published');
            if (existingPs) {
                skippedCount++;
                continue; 
            }

            const searchIds = [uid];
            if (staff.authUid) searchIds.push(staff.authUid);

            let mySchedCount = 0; let majorityDays = 26; 
            searchIds.forEach(sid => { if(schedules[sid]) mySchedCount += schedules[sid].length; });

            let actWorkedDays = 0, totalWorkMs = 0, totalLateMs = 0, lateCount = 0;
            let phUnworkedDays = 0, phWorkedDays = 0, phWorkedMs = 0, phUnworkedMs = 0;
            let absentDays = 0, absentHrs = 0;
            
            let totalLateFraction = 0;
            let weekdayLateFraction = 0, satLateFraction = 0;
            let totalWeekdayLateMs = 0, totalSatLateMs = 0;

            const satMulti = parseFloat(globalSettings.satMultiplier || 1.0);
            
            const toDateObj = (t, dateStr) => {
                if(!t) return null;
                if(t.toDate) return t.toDate();
                if(typeof t === 'string' && t.includes(':')) return new Date(`${dateStr}T${t}:00`);
                return new Date(t);
            };

            const myAtt = searchIds.map(sid => attendances[sid] || {}).reduce((acc, curr) => ({...acc, ...curr}), {});
            const mySchedsList = searchIds.map(sid => schedules[sid] || []).flat().reduce((acc, s) => { acc[s.date] = s; return acc; }, {});

            const userLeaves = {};
            leaves.forEach(l => {
                if (searchIds.includes(l.uid) || searchIds.includes(l.authUid)) {
                    const [sY, sM, sD] = l.startDate.split('-');
                    const [eY, eM, eD] = l.endDate.split('-');
                    let curr = new Date(sY, sM - 1, sD);
                    const endD = new Date(eY, eM - 1, eD);
                    const lVal = (l.days !== undefined && l.days < 1) ? parseFloat(l.days) : 1; 

                    while(curr <= endD) {
                        const dStr = `${curr.getFullYear()}-${String(curr.getMonth() + 1).padStart(2, '0')}-${String(curr.getDate()).padStart(2, '0')}`;
                        if (dStr >= startDate && dStr <= endDate) { 
                            userLeaves[dStr] = { type: l.type, val: lVal }; 
                        }
                        curr.setDate(curr.getDate() + 1);
                    }
                }
            });

            // --- MODIFIED LOGIC: Handle Termination Date per Staff ---
            let daysInMonthForStaff = daysInMonth;
            const termDate = staff.employment?.termDate;
            const isTerminatedThisMonth = termDate && termDate.startsWith(monthStr);
            if (isTerminatedThisMonth) {
                daysInMonthForStaff = parseInt(termDate.split('-')[2], 10);
            }
            // ---------------------------------------------------------

            for (let d = 1; d <= daysInMonthForStaff; d++) {
                const dateStr = `${year}-${month}-${String(d).padStart(2, '0')}`;
                const records = myAtt[dateStr];
                const sched = mySchedsList[dateStr];
                const leaveObj = userLeaves[dateStr];
                const leaveType = leaveObj?.type;
                const leaveVal = leaveObj?.val || 0; 
                const isPH = !!holidaysMap[dateStr];
                
                const validPH = isPH && (!!sched || !!leaveType);

                let schedDurMs = 8 * 3600000;
                if (sched && sched.start && sched.end) {
                    const sStart = toDateObj(sched.start, dateStr);
                    const sEnd = toDateObj(sched.end, dateStr);
                    schedDurMs = sEnd - sStart;
                    if (sched.breakMins) schedDurMs -= (sched.breakMins * 60000);
                    if (schedDurMs <= 0) schedDurMs = 8 * 3600000;
                }

                if (records && records.in) {
                    const isSat = new Date(dateStr).getDay() === 6;
                    
                    let actAdd = isSat ? satMulti : 1;
                    if (leaveVal === 0.5) actAdd = 0.5;
                    
                    actWorkedDays += actAdd;

                    if (sched && sched.start) {
                        const inTime = toDateObj(records.in, dateStr);
                        const schedStart = toDateObj(sched.start, dateStr);
                        if (inTime > schedStart) { 
                            const lateMs = inTime - schedStart;
                            totalLateMs += lateMs; 
                            lateCount++; 
                            const frac = lateMs / schedDurMs;
                            totalLateFraction += frac;
                            if (isSat) {
                                totalSatLateMs += lateMs;
                                satLateFraction += frac;
                            } else {
                                totalWeekdayLateMs += lateMs;
                                weekdayLateFraction += frac;
                            }
                        }
                    }

                    let workMsThisDay = 0;
                    if (records.out) {
                        const inTime = toDateObj(records.in, dateStr);
                        const outTime = toDateObj(records.out, dateStr);
                        workMsThisDay = outTime - inTime;
                        
                        if (records.breakOut && records.breakIn) {
                            const bOut = toDateObj(records.breakOut, dateStr);
                            const bIn = toDateObj(records.breakIn, dateStr);
                            const breakDur = bIn - bOut;
                            if (breakDur > 0) {
                                workMsThisDay -= breakDur;

                                const allowedBreakMins = (sched && sched.breakMins) ? sched.breakMins : 60;
                                const allowedBreakMs = allowedBreakMins * 60000;
                                if (breakDur > allowedBreakMs) {
                                    const lateMs = breakDur - allowedBreakMs;
                                    totalLateMs += lateMs;
                                    lateCount++;
                                    const frac = lateMs / schedDurMs;
                                    totalLateFraction += frac;
                                    if (isSat) {
                                        totalSatLateMs += lateMs;
                                        satLateFraction += frac;
                                    } else {
                                        totalWeekdayLateMs += lateMs;
                                        weekdayLateFraction += frac;
                                    }
                                }
                            }
                        }

                        if (sched && sched.start && sched.end) {
                            const sStart = toDateObj(sched.start, dateStr);
                            const sEnd = toDateObj(sched.end, dateStr);
                            let schedDurMsLimit = sEnd - sStart;
                            if (sched.breakMins) schedDurMsLimit -= sched.breakMins * 60000;

                            if (schedDurMsLimit > 0 && workMsThisDay > schedDurMsLimit) {
                                workMsThisDay = schedDurMsLimit;
                            }
                        }
                        if(workMsThisDay > 0) totalWorkMs += workMsThisDay;
                    }
                    
                    if (validPH) {
                        phWorkedDays += isSat ? satMulti : 1;
                        phWorkedMs += (workMsThisDay > 0 ? workMsThisDay : 0);
                    }
                } else {
                    if (validPH) {
                        const isSat = new Date(dateStr).getDay() === 6;
                        phUnworkedDays += isSat ? satMulti : 1;
                        
                        if (sched && sched.start && sched.end) {
                            let schedDurMsPH = toDateObj(sched.end, dateStr) - toDateObj(sched.start, dateStr);
                            if (sched.breakMins) schedDurMsPH -= sched.breakMins * 60000;
                            if (schedDurMsPH > 0) phUnworkedMs += schedDurMsPH;
                        } else if (leaveType) {
                            phUnworkedMs += 8 * 3600000;
                        }
                    } else if (sched && !leaveType) {
                        const isSat = new Date(dateStr).getDay() === 6;
                        absentDays += isSat ? satMulti : 1;
                        if (sched.start && sched.end) {
                            let schedDurMsAbs = toDateObj(sched.end, dateStr) - toDateObj(sched.start, dateStr);
                            if (sched.breakMins) schedDurMsAbs -= sched.breakMins * 60000;
                            if (schedDurMsAbs > 0) absentHrs += (schedDurMsAbs / 3600000);
                        }
                    }
                }
            }

            let annualLeaveCount = 0, medicalLeaveCount = 0, unpaidLeaveCount = 0;
            let unpaidLeaveHrs = 0;
            
            for (const [dateStr, leaveObj] of Object.entries(userLeaves)) {
                const lType = leaveObj.type;
                const lVal = parseFloat(leaveObj.val) || 1; 
                
                const validPH = !!holidaysMap[dateStr] && (!!mySchedsList[dateStr] || !!lType);
                
                if (!myAtt[dateStr]?.in || lVal < 1 || !validPH) {
                    if (lType.includes('Annual') || lType.includes('年假') || lType.includes('Cuti Tahunan')) {
                        annualLeaveCount += lVal;
                    }
                    else if (lType.includes('Medical') || lType.includes('病假') || lType.includes('Cuti Sakit')) {
                        medicalLeaveCount += lVal;
                    }
                    else {
                        unpaidLeaveCount += lVal;
                        const sched = mySchedsList[dateStr];
                        if (sched && sched.start && sched.end) {
                            let schedDurMs = toDateObj(sched.end, dateStr) - toDateObj(sched.start, dateStr);
                            if (sched.breakMins) schedDurMs -= sched.breakMins * 60000;
                            if (schedDurMs > 0) unpaidLeaveHrs += (schedDurMs / 3600000) * lVal;
                        } else {
                            unpaidLeaveHrs += 8 * lVal;
                        }
                    }
                }
            }

            const paidLeaveCount = annualLeaveCount + medicalLeaveCount;
            const totalDecimalHrs = totalWorkMs / 3600000;
            const phUnworkedHrsDec = phUnworkedMs / 3600000;
            const phWorkedHrsDec = phWorkedMs / 3600000;
            const totalLateMins = Math.floor(totalLateMs / 60000);
            
            const totalRecordedDays = actWorkedDays + paidLeaveCount + phUnworkedDays + unpaidLeaveCount + absentDays;
            const unscheduledDays = Math.max(0, majorityDays - totalRecordedDays);

            const totalRecordedHrs = totalDecimalHrs + phUnworkedHrsDec + (paidLeaveCount * 8) + unpaidLeaveHrs + absentHrs;
            const unscheduledHrs = Math.max(0, majorityHours - totalRecordedHrs);

            let totalAdvanceDed = 0;
            searchIds.forEach(sid => { if(advances[sid]) totalAdvanceDed += advances[sid]; });

            const fullBasic = parseFloat(staff.payroll?.basic) || 0;
            let baseGross = fullBasic; 
            let phExtraGross = 0, autoLateDeduct = 0;
            let absentDed = 0, unpaidDed = 0, unscheduledDed = 0;

            if (globalSettings.calcMode === 'hourly') {
                const exactHrRate = (majorityHours > 0) ? (fullBasic / majorityHours) : 0;
                
                absentDed = exactHrRate * absentHrs;
                unpaidDed = exactHrRate * unpaidLeaveHrs;
                let rawUnschedDed = exactHrRate * unscheduledHrs;
                
                phExtraGross = exactHrRate * phWorkedHrsDec * 2;

                if (globalSettings.lateMode === 'times') {
                    unscheduledDed = rawUnschedDed;
                    autoLateDeduct = lateCount * (parseFloat(globalSettings.lateFixedAmount) || 0);
                } else {
                    const lateHrs = totalLateMins / 60;
                    let calculatedLateDed = lateHrs * exactHrRate;
                    if (calculatedLateDed > rawUnschedDed) calculatedLateDed = rawUnschedDed;
                    
                    autoLateDeduct = calculatedLateDed;
                    unscheduledDed = rawUnschedDed - autoLateDeduct;
                }
            } else {
                const exactDailyRate = majorityDays > 0 ? (fullBasic / majorityDays) : 0;
                
                absentDed = exactDailyRate * absentDays;
                unpaidDed = exactDailyRate * unpaidLeaveCount;
                unscheduledDed = exactDailyRate * unscheduledDays;
                
                phExtraGross = phWorkedDays * 2 * exactDailyRate;

                if (globalSettings.lateMode === 'times') {
                    autoLateDeduct = lateCount * (parseFloat(globalSettings.lateFixedAmount) || 0);
                } else {
                    autoLateDeduct = exactDailyRate * totalLateFraction;
                }
            }

            let earnedBasicForStatutory = baseGross - absentDed - unpaidDed - unscheduledDed - autoLateDeduct;
            if (earnedBasicForStatutory < 0) earnedBasicForStatutory = 0;

            let stat = { epfEmp: 0, epfEmpr: 0, socsoEmp: 0, socsoEmpr: 0, eisEmp: 0, eisEmpr: 0, skbkkEmp: 0 };
            if (staff.statutory) {
                const epfRaw = staff.statutory.epf?.contrib || '11';
                stat = calculateMalaysiaStatutory(earnedBasicForStatutory, 0, 0, phExtraGross, epfRaw);
            }

            const grossTotal = baseGross + phExtraGross; 
            const totalDed = stat.epfEmp + stat.socsoEmp + stat.eisEmp + stat.skbkkEmp + autoLateDeduct + absentDed + unpaidDed + unscheduledDed + totalAdvanceDed;
            const net = grossTotal - totalDed;

            const payload = {
                uid: uid, 
                authUid: staff.authUid || null, 
                month: monthStr,
                endDate: isTerminatedThisMonth ? termDate : null, // MODIFIED: Save to database
                companyName: globalSettings.defaultCompany || 'RH RIDER HUB MOTOR (M) SDN. BHD.',
                staffName: staff.displayName,
                staffCode: staff.displayId,
                icNo: staff.personal?.icNo || '-',
                epfNo: staff.statutory?.epf?.no || '-',
                socsoNo: staff.statutory?.socso?.no || '-',
                department: staff.employment?.dept || '-',
                bankAcc: staff.payroll?.bank1?.acc || '-',
                bankName: staff.payroll?.bank1?.name || '-',
                joinDate: staff.employment?.joinDate || null,
                basic: fullBasic,
                final_basic: parseFloat(baseGross.toFixed(2)), 
                earnings: { commission: 0, ot: 0, allowance: 0, reimbursement: 0, phPay: parseFloat(phExtraGross.toFixed(2)), total: parseFloat(grossTotal.toFixed(2)) },
                deductions: { 
                    absent: parseFloat(absentDed.toFixed(2)), 
                    unpaidLeave: parseFloat(unpaidDed.toFixed(2)), 
                    unscheduled: parseFloat(unscheduledDed.toFixed(2)), 
                    epf: stat.epfEmp, 
                    socso: stat.socsoEmp, 
                    eis: stat.eisEmp, 
                    skbkk: stat.skbkkEmp,
                    tax: 0, 
                    late: parseFloat(autoLateDeduct.toFixed(2)), 
                    advance: parseFloat(totalAdvanceDed.toFixed(2)), 
                    total: parseFloat(totalDed.toFixed(2)) 
                },
                employer_epf: stat.epfEmpr, 
                employer_socso: stat.socsoEmpr, 
                employer_eis: stat.eisEmpr,
                attendanceStats: {
                    stdDays: majorityDays, actDays: actWorkedDays,
                    annualLeave: annualLeaveCount, medicalLeave: medicalLeaveCount, unpaidLeave: unpaidLeaveCount,
                    absentDays: absentDays, unscheduledDays: unscheduledDays,
                    phUnworked: phUnworkedDays, phWorked: phWorkedDays,
                    phUnworkedHrs: parseFloat(phUnworkedHrsDec),
                    totalHrs: totalDecimalHrs,
                    lateMins: totalLateMins, lateCount: lateCount, 
                    lateFraction: totalLateFraction,
                    weekdayLateFraction: weekdayLateFraction,
                    satLateFraction: satLateFraction,
                    weekdayLateMins: Math.floor(totalWeekdayLateMs / 60000),
                    satLateMins: Math.floor(totalSatLateMs / 60000),
                    mode: globalSettings.calcMode,
                    majorityHours: majorityHours
                },
                gross: parseFloat(grossTotal.toFixed(2)), net: parseFloat(net.toFixed(2)), 
                status: 'Draft', 
                // 🟢 当通过批量生成创建时，搜索之前同月所有的记录，如果有就将这些记录设为无效或者直接删除
                updatedAt: serverTimestamp(),
                createdAt: serverTimestamp()
            };

            // 🟢 如果找到属于这个人的 Draft，覆盖最后那一张，如果没有，创建新的一张
            const draftPs = currentPayrollData.find(p => p.uid === uid && p.month === monthStr && p.status === 'Draft');
            const targetId = draftPs ? draftPs.id : payslipId;

            batch.set(doc(db, "payslips", targetId), payload);
            generatedCount++;
        }

        if (generatedCount > 0) {
            await batch.commit();
            await logAdminAction(db, auth.currentUser, "BATCH_GENERATE_PAYSLIPS", "MULTIPLE", null, { count: generatedCount, month: monthStr });
        }

        hideLoading();
        let msg = `Batch generation complete!\nGenerated ${generatedCount} Drafts.`;
        if(skippedCount > 0) msg += `\nSkipped ${skippedCount} already Published payslips.`;
        alert(msg); 
        
        window.loadPayroll();

    } catch (e) {
        hideLoading();
        console.error(e);
        alert("Batch Generation Failed: " + e.message);
    }
};

window.currentViewingPayslipId = null;

window.navigatePayslip = function(direction) {
    if (!window.currentViewingPayslipId || !currentPayrollData || currentPayrollData.length === 0) return;

    const currentIndex = currentPayrollData.findIndex(p => p.id === window.currentViewingPayslipId);
    if (currentIndex === -1) return;

    let newIndex = currentIndex + direction;
    if (newIndex < 0) newIndex = currentPayrollData.length - 1;
    if (newIndex >= currentPayrollData.length) newIndex = 0;

    const nextPayslip = currentPayrollData[newIndex];
    
    if (nextPayslip) {
        const modalBody = document.querySelector('#payslipFormModal .modal-body');
        if (modalBody) {
            modalBody.style.opacity = '0.3';
            setTimeout(() => { modalBody.style.opacity = '1'; }, 150);
        }
        window.openEditModal(nextPayslip.id);
    }
};

window.deletePayslip = async () => {
    const docId = document.getElementById('editDocId')?.value;
    if (!docId) return;

    if (!confirm("⚠️ Are you sure you want to DELETE this payslip?")) return;
    if (!confirm("🚨 DOUBLE CONFIRMATION:\n\nDeleting this payslip will permanently remove it from the system. If it was already Published, any deducted salary advances will NOT be automatically reverted.\n\nProceed with deletion?")) return;

    showLoading();
    try {
        const psRef = doc(db, "payslips", docId);
        const snap = await getDoc(psRef);
        const oldData = snap.exists() ? snap.data() : null;

        await deleteDoc(psRef);
        await logAdminAction(db, auth.currentUser, "DELETE_PAYSLIP", docId, oldData, null);

        if(formModal) formModal.hide();
        hideLoading();
        showStatusAlert('statusMessage', 'Payslip successfully deleted.', true);
        window.loadPayroll();

    } catch (e) {
        hideLoading();
        console.error(e);
        showStatusAlert('statusMessage', `Failed to delete: ${e.message}`, false);
    }
};

document.addEventListener('keydown', (e) => {
    const formModalEl = document.getElementById('payslipFormModal');
    
    if (formModalEl && formModalEl.classList.contains('show') && window.currentViewingPayslipId) {
        
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
            if (e.altKey && e.key === 'ArrowLeft') window.navigatePayslip(-1);
            if (e.altKey && e.key === 'ArrowRight') window.navigatePayslip(1);
            return; 
        }

        if (e.key === 'ArrowLeft') {
            e.preventDefault(); 
            window.navigatePayslip(-1);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            window.navigatePayslip(1);
        }
    }
});