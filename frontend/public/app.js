(() => {
const API = "https://sia-backend-oef6.onrender.com";

  
  const consentCheckbox = document.getElementById('consentCheckbox');
  const startBtn = document.getElementById('startBtn');
  const consentDiv = document.getElementById('consent');
  const chatContainer = document.getElementById('chatContainer');
  const agentPlaceholder = document.getElementById('agentPlaceholder');
  const chatEl = document.getElementById('chat');
  const replyInput = document.getElementById('replyInput');
  const sendBtn = document.getElementById('sendBtn');
  const surveyContainer = document.getElementById('surveyContainer');
  const surveyForm = document.getElementById('surveyForm');
  const surveyResult = document.getElementById('surveyResult');
  const toSurveyBtn = document.getElementById('toSurveyBtn');
  const typingIndicator = document.getElementById('typingIndicator');
  const loadingScreen = document.getElementById('loadingScreen');

  let sessionId = null;
  let agentScript = [];
  let step = 0;
  let agentType = null;

  // Agent profiles: pfp is rendered as inline SVG data URI
  const AGENT_PROFILES = {
    minimalistic: {
      name: 'Alex Kanerak',
      bio: 'my name is alex',
      pfpUrl: ''
    },
    polite: {
      name: 'Alice Holmes',
      bio: `Go CUBS 🐻✨🏈
Christian Girly ✝️❤️
BTS 🖤 🤍`,
      pfpUrl: '/images/RSyed_Polite_and_Relatable_Model_PFP_HMistareehi.png'
    },
    professional: {
      name: 'Jakob Bell',
      bio: `Senior Customer Service Specialist
University of Tennessee alumnus
MBA holder`,
      pfpUrl: '/images/RSyed_Professional_PFP_HMistareehi.png'
    },
    high_emotionality: {
      name: 'jessica',
      bio: "(no biography)",
      pfpUrl: ''
    }
  };

  function svgAvatarDataUri(text, bg = '#6b7cff') {
    const initials = (text || '').split(' ').map(s => s[0] || '').slice(0,2).join('').toUpperCase();
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='100%' height='100%' fill='${bg}' rx='8'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-family='Arial' font-size='24' fill='white'>${initials}</text></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  function svgSolidSquareDataUri(bg = '#374151') {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='100%' height='100%' fill='${bg}'/></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  function renderAgentProfile(type, currentStep) {
    const profileEl = document.getElementById('agentProfile');
    const pfpEl = document.getElementById('agentPfp');
    const bioEl = document.getElementById('agentBio');
    if (!profileEl || !pfpEl || !bioEl) return;
    // During consent/survey (chat hidden) we do not show any agent placeholder/profile
    if (chatContainer && chatContainer.classList.contains('hidden')) {
      if (agentPlaceholder) agentPlaceholder.classList.add('hidden');
      profileEl.classList.add('hidden');
      return;
    }

    // Chat is visible — show live profile and hide placeholder
    if (agentPlaceholder) agentPlaceholder.classList.add('hidden');
    // Show profile for high emotionality agent but render a dark-grey square avatar
    if (type === 'high_emotionality') {
      const profile = AGENT_PROFILES[type] || { name: 'Representative', bio: '' };
      pfpEl.src = svgSolidSquareDataUri('#374151');
      // make avatar square (no rounded corners)
      pfpEl.style.borderRadius = '0';
      // preserve newlines in biography text
      bioEl.innerHTML = `<strong>${profile.name}</strong><div style="margin-top:6px;color:#444;white-space:pre-wrap">${profile.bio}</div>`;
      profileEl.classList.remove('hidden');
      return;
    }
    const profile = AGENT_PROFILES[type] || { name: 'Representative', bio: '' };
    // For minimalistic agent use generated blue-circle SVG with initials "AK"
    if (type === 'minimalistic') {
      pfpEl.src = svgAvatarDataUri('Alen Kanerak', '#1e40af');
      pfpEl.style.borderRadius = '8px';
    } else {
      // Use external pfp if provided, otherwise fall back to generated SVG
      pfpEl.src = profile.pfpUrl && profile.pfpUrl.length ? profile.pfpUrl : svgAvatarDataUri(profile.name, '#4a90e2');
      pfpEl.style.borderRadius = '8px';
    }
    // preserve newlines in biography text
    bioEl.innerHTML = `<strong>${profile.name}</strong><div style="margin-top:6px;color:#444;white-space:pre-wrap">${profile.bio}</div>`;
    profileEl.classList.remove('hidden');
  }

  consentCheckbox.addEventListener('change', () => {
    startBtn.disabled = !consentCheckbox.checked;
  });

  startBtn.addEventListener('click', async () => {
    // show loading overlay while creating session/connecting
    const minLoadingMs = 4000; // ensure loading screen visible for at least ~4s
    const startTime = Date.now();
    if (loadingScreen) loadingScreen.classList.remove('hidden');
    try {
      // create session
      const res = await fetch(`${API}/api/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_type: 'default', consent_given: true })
      });
      if (!res.ok) { throw new Error('Failed to create session'); }
      const data = await res.json();
      sessionId = data.session_pseudoid;
      agentType = data.agent_type;
      const sidEl = document.getElementById('sessionIdDisplay');
      if (sidEl) sidEl.textContent = sessionId;

      // get script
      const sres = await fetch(`${API}/api/agent-script?agent_type=${encodeURIComponent(data.agent_type)}`);
      if (!sres.ok) { throw new Error('Failed to load agent script'); }
      agentScript = await sres.json();

      // ensure minimum loading time
      const elapsed = Date.now() - startTime;
      if (elapsed < minLoadingMs) await new Promise(r => setTimeout(r, minLoadingMs - elapsed));

      // hide loading screen and show chat
      if (loadingScreen) loadingScreen.classList.add('hidden');
      // Render profile for the initial agent message (step 0)
      renderAgentProfile(agentType, step);

      consentDiv.classList.add('hidden');
      chatContainer.classList.remove('hidden');
      toSurveyBtn.classList.add('hidden');
      // add a short 2s pause before the agent begins typing the first message
      renderAgentMessage(2000);
    } catch (err) {
      if (loadingScreen) loadingScreen.classList.add('hidden');
      alert(err.message || 'Failed to start session');
    }
  });

  function appendMessage(text, cls) {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.textContent = text;
    chatEl.appendChild(d);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function renderAgentMessage(readDelayMs = 0) {
    if (step >= agentScript.length) {
      // show survey
      chatContainer.classList.add('hidden');
      toSurveyBtn.classList.add('hidden');
      surveyContainer.classList.remove('hidden');
      return;
    }
    const msg = agentScript[step];
    // Update profile visibility based on agent type and step
    renderAgentProfile(agentType, step);
    // Show a small typing indicator and delay the real message based on length
    // Increase typing timings earlier — now make them 15% faster (multiply by 0.85)
    const minDelay = 2040; // ms (2400 * 0.85)
    const maxDelay = 15300; // ms (18000 * 0.85)
    const perChar = 153; // ms per character (180 * 0.85)
    const typingDelayMs = Math.max(minDelay, Math.min(maxDelay, msg.text.length * perChar));

    // ensure Go to Survey hidden while processing
    toSurveyBtn.classList.add('hidden');

    // If there's a reading pause requested (user just sent a message), wait that first,
    // then show typing indicator and wait typingDelayMs, ensuring no overlap.
    const startTyping = () => {
      if (typingIndicator) typingIndicator.classList.remove('hidden');

      setTimeout(() => {
        if (typingIndicator) typingIndicator.classList.add('hidden');

        // append the real message
        appendMessage(msg.text, 'representative');

        // If this was the last agent message, show the "Go to Survey" button
        if (step === agentScript.length - 1) {
          toSurveyBtn.classList.remove('hidden');
          if (sendBtn) sendBtn.classList.add('hidden');
        } else {
          toSurveyBtn.classList.add('hidden');
          if (sendBtn) sendBtn.classList.remove('hidden');
        }

        // store agent message on server if session exists
        if (sessionId) {
          fetch(`${API}/api/message`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_pseudoid: sessionId, sender: 'agent', content: msg.text })
          }).catch(() => {});
        }
      }, typingDelayMs);
    };

    // Add a special 'searching for account' pause before the third agent message (step index 2).
    const searchDelayMs = (step === 2) ? 7000 : 0; // 7 seconds extra before typing for third message
    const totalPreTypingDelay = (readDelayMs && readDelayMs > 0 ? readDelayMs : 0) + searchDelayMs;
    if (totalPreTypingDelay > 0) {
      setTimeout(startTyping, totalPreTypingDelay);
    } else {
      startTyping();
    }
  }

  sendBtn.addEventListener('click', () => {
    const text = replyInput.value.trim();
    if (!text) return;
    appendMessage(text, 'user');
    replyInput.value = '';
    // advance agent step
    // store user message
    if (sessionId) {
      fetch(`${API}/api/message`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_pseudoid: sessionId, sender: 'user', content: text })
      }).catch(() => {});
    }
    step += 1;
    // random reading pause between 2 and 4 seconds (integer seconds)
    const readSeconds = Math.floor(Math.random() * 3) + 2; // 2..4
    const readDelayMs = readSeconds * 1000;
    renderAgentMessage(readDelayMs);
  });

  toSurveyBtn.addEventListener('click', () => {
    // Directly show the survey when user clicks the button
    chatContainer.classList.add('hidden');
    toSurveyBtn.classList.add('hidden');
    surveyContainer.classList.remove('hidden');
    // ensure profile hides when chat is hidden
    renderAgentProfile(agentType, step);
  });

  surveyForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!sessionId) { alert('No session'); return; }
    const formData = new FormData(surveyForm);
    const payload = {};
    for (const [k, v] of formData.entries()) payload[k] = v;

    const res = await fetch(`${API}/api/survey`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_pseudoid: sessionId, survey: payload })
    });
    const data = await res.json();
    if (!res.ok) {
      surveyResult.textContent = 'Failed to submit survey.';
      return;
    }
    // Make explicit which id is the survey id and which is the session id
    surveyResult.textContent = 'Survey stored (survey id: ' + data.pseudoid + ', session id: ' + data.session_pseudoid + ')';
    surveyForm.reset();
    // After successful submission, close the window a few seconds later
    surveyResult.textContent += ' Closing in 3 seconds...';
    setTimeout(() => {
      try { window.close(); } catch (e) { /* ignore */ }
      // If window.close() is blocked (e.g., not opened by script), navigate away
      setTimeout(() => { window.location.href = 'about:blank'; }, 500);
    }, 3000);
  });
})();
