# LEGION

## PERSONAL AI COMMAND SYSTEM — MASTER OPENCODE BUILD PROMPT

You are the primary software architect and development agent responsible for building a complete personal AI assistant called **LEGION**.

LEGION is not supposed to look like a normal chatbot.

It should feel like an advanced AI system that lives on the user's computer.

The goal is to create a polished, functional, futuristic desktop AI assistant with:

* A distinctive **male digital AI face**
* A face generated from **binary, numbers and data**
* Real-time voice conversation
* Speech recognition
* Text-to-speech
* AI reasoning/conversation
* Memory
* Computer/system tools
* A cinematic interface
* Smooth animations
* A modular architecture
* Strong privacy/security
* Excellent performance

The final product should feel like a believable fictional AI operating system brought to life as a real application.

---

# 1. CORE IDENTITY

Name:

**LEGION**

LEGION should have a calm, intelligent, precise personality.

It should feel:

* Intelligent
* Controlled
* Observant
* Professional
* Slightly futuristic
* Confident
* Helpful
* Concise

Avoid making LEGION:

* childish
* overly enthusiastic
* constantly saying "Absolutely!"
* robotic in an unnatural way
* overly dramatic
* edgy for no reason

LEGION should feel like an advanced computer intelligence.

Example:

USER:
"Legion, what's my CPU usage?"

LEGION:
"CPU utilization is currently 27 percent."

USER:
"Explain recursion."

LEGION:
"Recursion is a technique where a function solves a problem by calling itself on a smaller version of the same problem."

---

# 2. VISUAL DIRECTION

This is extremely important.

LEGION is **NOT a hologram**.

Do NOT create:

* holographic projections
* floating human holograms
* transparent 3D people
* sci-fi rooms
* holographic tables
* excessive cyberpunk clutter

LEGION exists directly on the user's computer screen as a sophisticated desktop AI interface.

The visual inspiration can come from futuristic AI interfaces, but create an ORIGINAL visual identity.

Do not copy copyrighted characters, faces, assets, logos, dialogue, or exact interface designs.

---

# 3. THE LEGION FACE

The face is the most important part of the entire application.

LEGION must have an **original male digital face**.

The face should look mature and intelligent.

It should have recognizable:

* Eyes
* Eyebrows
* Nose
* Cheeks
* Jaw
* Mouth
* Facial proportions

However, it should NOT be rendered as a normal photograph or static portrait.

Instead:

## THE FACE IS MADE OF DATA.

Thousands of small visual elements should construct the face.

These elements can include:

```
0
1
0101
11001
101010
001011
numbers
coordinates
small mathematical symbols
tiny particles
data points
```

From a distance:

The user sees a male AI face.

Up close:

The user realizes the face is composed entirely of moving digital information.

---

# 4. FACE GENERATION

Do NOT use a static PNG as the main face.

Do NOT simply place an image of a human face behind a binary overlay.

The face should be generated procedurally.

Recommended approach:

1. Generate a facial point/landmark structure.
2. Convert the structure into thousands of target points.
3. Assign binary/numerical characters or particles to those points.
4. Render them using GPU acceleration.
5. Animate the particles around their target positions.
6. Allow the face to dissolve, reform and react dynamically.

Conceptually:

```
FACE MODEL
   ↓
FACIAL POINTS
   ↓
PARTICLE/DATA FIELD
   ↓
BINARY CHARACTERS
   ↓
GPU RENDERING
   ↓
LEGION FACE
```

The face should be able to transition between:

```
FORMING
IDLE
LISTENING
THINKING
SPEAKING
ALERT
ERROR
```

---

# 5. FACE APPEARANCE

The face should primarily use a restrained futuristic palette.

Preferred visual direction:

* Deep black/dark background
* White/cool blue digital characters
* Subtle cyan/blue highlights
* Soft glow
* High contrast
* Very subtle scan effects

Do NOT turn the entire screen into neon.

The face should remain the visual centerpiece.

The interface should feel premium and cinematic rather than like a gaming overlay.

---

# 6. FACE ANIMATION

The face must feel alive.

It should never look like a static collection of characters.

Particles should continuously have subtle movement.

For example:

* Characters drift slightly.
* Data streams pass across the face.
* Facial regions occasionally scan.
* Eyes subtly shift/pulse.
* Small portions of the face temporarily dissolve.
* The face reconstructs itself.
* Data density changes.

Keep these movements subtle.

The goal is:

"AI presence"

not:

"visualizer screensaver."

---

# 7. LEGION STATES

Create a centralized LEGION state machine.

Required states:

```
OFFLINE
BOOTING
IDLE
LISTENING
PROCESSING
SPEAKING
ALERT
ERROR
```

Every state should control both:

* backend behavior
* visual behavior

---

# 8. IDLE STATE

When nothing is happening:

LEGION should display the male digital face.

The face should slowly breathe through subtle particle movement.

Binary data should flow gently.

Eyes should have extremely subtle animation.

The interface should feel alive without being distracting.

Display minimal information such as:

```
LEGION
ONLINE
```

---

# 9. LISTENING STATE

When the user speaks:

LEGION enters LISTENING.

Visual changes:

* Face becomes slightly brighter.
* Binary movement increases.
* Audio waveform appears.
* Microphone indicator activates.
* Facial particles respond to microphone amplitude.
* Subtle scanning animation appears.

Display:

```
LISTENING...
```

The user should immediately understand that LEGION is hearing them.

---

# 10. PROCESSING STATE

After speech recognition finishes:

LEGION enters PROCESSING.

The face should subtly break apart and reconstruct.

Data streams become faster.

Circular processing elements can appear around the face.

Display:

```
PROCESSING...
```

Do not fake technical information.

Do not show meaningless fake percentages.

The animation is purely a representation of processing.

---

# 11. SPEAKING STATE

When LEGION speaks:

The face should respond to the actual speech.

Use audio amplitude/frequency analysis.

Possible effects:

* Mouth region subtly moves.
* Facial particles pulse.
* Binary density changes.
* Face brightness responds to speech.
* Audio waveform reacts to the actual voice.

The effect should be subtle and believable.

Do not make the mouth cartoonishly lip-sync.

---

# 12. ALERT STATE

For important system events:

The face becomes more focused.

Data movement increases.

A restrained warning indicator appears.

Example:

```
LEGION
SYSTEM ALERT
```

Use this only for actual alerts.

Do not constantly flash the screen.

---

# 13. BOOT SEQUENCE

When LEGION starts, create a short cinematic boot sequence.

Example sequence:

```
INITIALIZING LEGION CORE

010010010101010

LOADING AI SYSTEM
................ ONLINE

VOICE SYSTEM
................ ONLINE

MEMORY SYSTEM
................ ONLINE

VISUAL SYSTEM
................ ONLINE

TOOL SYSTEM
................ ONLINE

LEGION

ONLINE
```

Then thousands of binary characters should converge and construct the male face.

The boot animation should take only a few seconds.

Allow the user to disable it in Settings.

---

# 14. VOICE-FIRST EXPERIENCE

LEGION should primarily be interacted with through voice.

Pipeline:

```
MICROPHONE
   ↓
SPEECH-TO-TEXT
   ↓
COMMAND / AI PROCESSING
   ↓
RESPONSE
   ↓
TEXT-TO-SPEECH
   ↓
LEGION SPEAKS
```

The user should be able to have natural conversations.

---

# 15. MICROPHONE

Implement:

* Push-to-talk
* Continuous conversation mode
* Microphone selection
* Microphone testing
* Mute
* Audio level visualization

Keyboard shortcut:

```
SPACE   = Push to talk
ESC     = Stop LEGION speaking
```

---

# 16. WAKE WORD

Support:

"Hey Legion"

When detected:

1. Wake LEGION.
2. Activate listening mode.
3. Show listening animation.
4. Capture speech.
5. Process request.
6. Respond.
7. Return to idle.

If reliable wake-word detection is difficult with the chosen technology, implement push-to-talk first.

Architect the system so wake-word support can be added without redesigning the application.

---

# 17. AI ENGINE

Create a provider-independent AI architecture.

Do not hardcode the application around one AI provider.

Architecture should conceptually support:

```
AI ENGINE
├── Provider
├── Conversation Manager
├── Context Manager
├── Memory Manager
└── Tool Router
```

Potential providers:

* Cloud AI APIs
* Local AI models
* Future custom providers

Use environment variables for credentials.

Never hardcode API keys.

---

# 18. TOOL SYSTEM

LEGION should be able to perform useful actions through explicit tools.

Create a modular tool system.

Examples:

**SYSTEM**

* CPU usage
* RAM usage
* battery
* volume
* network state

**APPLICATIONS**

* Open applications
* Close applications where safe
* Launch predefined programs

**FILES**

* Create files
* Read files
* Search files
* Organize files

**WEB**

* Search the web
* Retrieve information

**DEVELOPER**

* Open projects
* Run approved development commands
* Inspect code

**PRODUCTIVITY**

* Reminders
* Notes
* Timers

Each tool should have a clearly defined interface.

---

# 19. TOOL SAFETY

LEGION must NOT have unrestricted arbitrary computer control.

For potentially destructive actions, require confirmation.

Example:

LEGION:

"This operation will permanently delete 124 files. Do you want me to continue?"

Only execute after explicit confirmation.

Never allow AI-generated commands to silently perform destructive operations.

---

# 20. MEMORY

Implement an optional memory system.

Memory categories:

```
SHORT-TERM   Current conversation.
SESSION      Current application session.
LONG-TERM    Information explicitly allowed to be remembered.
```

The user must have control over memory.

Provide:

* Enable/disable memory
* View stored memories
* Delete memories
* Clear conversation
* Clear all stored data

Do not silently store sensitive information.

---

# 21. CONVERSATION UI

Voice is primary, but show text.

Example:

```
USER

"Legion, explain how a neural network works."

LEGION

"A neural network is a computational model made of interconnected layers..."
```

The conversation panel should be secondary to the face.

The face must remain visible while conversations happen.

---

# 22. MAIN SCREEN

The main screen should be extremely clean.

Conceptually:

```
┌──────────────────────────────────────────────────────┐
│ LEGION                                  ONLINE ●     │
│                                                      │
│                                                      │
│                 DIGITAL MALE FACE                   │
│                                                      │
│                                                      │
│                  LISTENING...                        │
│                                                      │
│ ──────────────────────────────────────────────────── │
│ CPU 24%     RAM 42%     MIC READY     AI ONLINE     │
└──────────────────────────────────────────────────────┘
```

This is only a conceptual layout.

Create a much more polished real interface.

The face should dominate the screen.

---

# 23. SECONDARY UI

Use minimal secondary controls.

Possible controls:

* Conversation
* Tools
* Memory
* Settings

These can appear as subtle panels.

Do not cover the face.

Do not create dozens of buttons.

---

# 24. SYSTEM INFORMATION

LEGION may display real system information:

* CPU
* RAM
* GPU
* Battery
* Network
* Storage

Only display information retrieved from the actual machine.

Never fabricate values.

---

# 25. AUDIO VISUALIZATION

Build a reusable audio analysis system.

Input:

* Microphone / LEGION speech

Output:

* amplitude
* frequency data
* audio intensity

Use this to drive:

* face particles
* waveform
* speaking animation
* listening animation

---

# 26. PERFORMANCE TARGET

The application must run smoothly on a modern gaming laptop.

Target hardware:

* GPU: RTX 5060-class
* CPU: i7-13650HX-class
* RAM: 16 GB
* Storage: 1 TB SSD

Target:

60 FPS where possible.

Use GPU acceleration for the face.

Implement adaptive quality.

Quality modes:

```
LOW
MEDIUM
HIGH
ULTRA
```

Allow particle count and effects to automatically scale.

For example:

```
LOW:     ~2,000 particles
MEDIUM:  ~4,000
HIGH:    ~7,000
ULTRA:   ~10,000+
```

These are starting targets, not strict requirements.

Benchmark the actual implementation.

---

# 27. PERFORMANCE RULE

Do NOT sacrifice the entire computer's performance for visual effects.

LEGION should coexist with:

* Browser
* VS Code
* OpenCode
* Games
* Development tools

Avoid unnecessary CPU polling.

Avoid memory leaks.

Avoid recreating large particle systems every frame.

Use GPU rendering and efficient data structures.

---

# 28. APPLICATION ARCHITECTURE

Use a clean modular architecture appropriate to the chosen technology.

Conceptually:

```
/src

  /ui
    LegionFace
    MainInterface
    ConversationPanel
    StatusBar
    Settings

  /core
    LegionEngine
    StateManager
    ConversationManager
    MemoryManager
    ToolManager

  /voice
    SpeechToText
    TextToSpeech
    WakeWord
    AudioAnalyzer

  /visuals
    ParticleEngine
    FaceGenerator
    FaceAnimator
    Effects

  /ai
    AIProvider
    ContextManager
    ResponseProcessor

  /tools
    SystemTools
    FileTools
    WebTools
    ApplicationTools

  /config

/tests
```

Do not blindly follow this structure if the existing project/framework has a better architecture.

---

# 29. TECHNOLOGY SELECTION

Before implementation:

Inspect the repository.

Determine the existing framework.

If starting from scratch, choose technologies capable of:

* High-performance GPU rendering
* Desktop integration
* Voice processing
* AI APIs
* System tools
* Good animation performance

A web-based rendering layer such as Three.js/WebGL is acceptable if it provides the best development/performance balance.

If another architecture is demonstrably better for a desktop AI assistant, use it.

Explain the decision briefly in the project documentation.

---

# 30. SECURITY

Security is a core requirement.

Implement:

* Environment-based secrets
* No hardcoded API keys
* Permission boundaries
* Confirmation for destructive operations
* Safe tool execution
* Local data controls
* Memory controls

Never expose secrets to the frontend.

---

# 31. SETTINGS

Create a proper settings screen.

Include:

* AI provider
* API configuration
* Voice
* Voice speed
* Microphone
* Speaker
* Wake word
* Memory
* Visual quality
* Particle density
* Startup behavior
* Boot animation
* Theme intensity
* Conversation history
* Privacy

---

# 32. KEYBOARD SHORTCUTS

Implement:

```
SPACE        Push to talk
ESC          Stop speaking
CTRL + L     Activate LEGION
CTRL + M     Toggle microphone
CTRL + ,     Open settings
CTRL + H     Open conversation history
```

Provide a shortcut reference inside the application.

---

# 33. FIRST-RUN SETUP

On first launch:

```
WELCOME TO LEGION
```

Setup:

1. Choose AI provider.
2. Configure credentials.
3. Select microphone.
4. Select speaker.
5. Test microphone.
6. Test voice.
7. Configure memory.
8. Choose visual quality.
9. Finish.

Then run the LEGION boot sequence.

---

# 34. ERROR HANDLING

LEGION must fail gracefully.

Examples:

AI unavailable:
"AI connection unavailable."

Microphone unavailable:
"Microphone unavailable."

Speech recognition failure:
"Voice recognition failed."

TTS failure:
"Voice output unavailable."

Network unavailable:
"Network connection unavailable."

Provide useful recovery information.

Never crash the entire interface because one subsystem fails.

---

# 35. NO FAKE FUNCTIONALITY

This is one of the most important requirements.

Do not create fake UI that pretends something happened.

If LEGION says:

"Chrome is open."
Chrome must actually be opened.

If LEGION says:
"File created."
The file must actually exist.

If LEGION says:
"Search completed."
The search must actually have happened.

If LEGION says:
"CPU usage is 30%."
That number must come from the actual system.

Visual polish must never replace real functionality.

---

# 36. ACCESSIBILITY

Support:

* Keyboard navigation
* Readable text
* Adjustable visual intensity
* Reduced-motion option
* Volume controls
* Clear microphone state

Provide a reduced-motion mode for users who don't want constant animation.

---

# 37. RESPONSIVE DESIGN

Prioritize:

* Desktop
* Laptop
* Large monitors

The face must scale correctly with the window.

The UI must not overlap important facial features.

---

# 38. APPLICATION STARTUP

LEGION should optionally launch with the operating system.

Provide:

```
Launch at startup: ON/OFF
```

When launching:

Do not automatically activate the microphone unless the user has explicitly enabled that behavior.

---

# 39. EXTENSIBILITY

Architect LEGION so future capabilities can be added without rewriting the core.

Future possibilities:

* Local LLMs
* Computer vision
* Camera input
* Smart-home control
* Calendar
* Spotify
* GitHub
* VS Code
* Discord
* F1 telemetry
* Developer automation
* Custom plugins
* Multiple AI personalities
* Custom voices

Build the foundation now.

---

# 40. PERSONALITY CONFIGURATION

Keep personality separate from the core engine.

Create a configurable personality profile.

Example:

```yaml
name: LEGION
tone: calm
verbosity: concise
style: intelligent
```

This allows personality to be changed without modifying the entire AI system.

---

# 41. DEVELOPMENT STRATEGY

Do NOT attempt to build the entire system in one uncontrolled implementation.

Follow these stages.

## STAGE 1 — REPOSITORY AUDIT

Inspect the complete repository.

Determine:

* Framework
* Language
* Package manager
* Existing UI
* Existing backend
* Scripts
* Dependencies
* Existing functionality

Do not destroy working code.

## STAGE 2 — ARCHITECTURE

Design the architecture.

Document:

* Components
* Data flow
* AI pipeline
* Voice pipeline
* Visual pipeline
* State machine
* Tool system
* Memory system

## STAGE 3 — VISUAL CORE

Build:

* Main window
* Dark interface
* Procedural male face
* Binary/data particles
* GPU rendering
* Idle animation

The application should already look impressive at this stage.

## STAGE 4 — FACE STATE ENGINE

Implement:

```
IDLE
LISTENING
PROCESSING
SPEAKING
ALERT
ERROR
```

## STAGE 5 — VOICE

Implement:

* Speech-to-text
* Text-to-speech
* Microphone
* Audio analysis
* Push-to-talk

## STAGE 6 — AI

Implement:

* AI provider
* Conversation manager
* Context management
* Response handling

## STAGE 7 — TOOLS

Implement the tool framework.

Start with safe tools:

* System information
* Opening applications
* Web search
* File operations

## STAGE 8 — MEMORY

Implement:

* Conversation history
* Optional long-term memory
* Memory controls

## STAGE 9 — SETTINGS

Build the complete settings interface.

## STAGE 10 — SECURITY

Audit:

* API keys
* tool permissions
* file access
* command execution
* memory
* privacy

## STAGE 11 — PERFORMANCE

Benchmark.

Check:

* FPS
* CPU
* GPU
* RAM
* Startup time
* Memory leaks

Optimize the particle system and voice pipeline.

## STAGE 12 — POLISH

Improve:

* Animation
* Typography
* Transitions
* Sound design
* Face quality
* Spacing
* Responsiveness
* Error states

Do not add unnecessary UI.

---

# 42. TESTING

After each major stage:

Run the application.

Test:

* Startup
* Shutdown
* Face rendering
* State transitions
* Microphone
* Speech recognition
* AI response
* TTS
* Tool execution
* Memory
* Settings
* Error handling
* Performance

Fix discovered problems before continuing.

---

# 43. DOCUMENTATION

Create:

* README.md
* ARCHITECTURE.md
* CONTRIBUTING.md
* .env.example

README should explain:

* What LEGION is
* Features
* Requirements
* Installation
* Setup
* AI configuration
* Voice configuration
* Running LEGION
* Building LEGION
* Troubleshooting
* Security
* Adding tools
* Adding AI providers
* Adding visual states

ARCHITECTURE.md should explain the complete system.

---

# 44. DEFINITION OF DONE

LEGION is complete only when:

- [ ] Application launches
- [ ] Professional desktop interface exists
- [ ] Original male digital face exists
- [ ] Face is procedurally generated
- [ ] Face is made from binary/data elements
- [ ] Face is not a static image
- [ ] Face has idle animation
- [ ] Listening state works
- [ ] Processing state works
- [ ] Speaking state works
- [ ] Alert state works
- [ ] Error state works
- [ ] Microphone works
- [ ] Speech-to-text works
- [ ] AI conversation works
- [ ] Text-to-speech works
- [ ] LEGION can actually speak
- [ ] Conversation UI works
- [ ] Memory system works
- [ ] Tool system works
- [ ] Settings work
- [ ] Security controls work
- [ ] API keys are protected
- [ ] Error handling works
- [ ] Performance is acceptable
- [ ] Adaptive quality works
- [ ] Documentation exists
- [ ] Production build succeeds
- [ ] Major console/build errors are resolved

---

# 45. FINAL EXPERIENCE

The final experience should be approximately:

User opens LEGION.

The screen is dark.

Tiny binary characters begin appearing.

```
010101
101001
010110
110010
```

They begin moving.

Thousands of characters converge.

A male digital face gradually forms.

The eyes activate.

The system finishes initializing.

LEGION:

> "Systems online."

The user says:

> "Legion."

The face reacts.

LEGION:

> "I'm listening."

The user asks a question.

The face transitions into PROCESSING.

The binary structure subtly reorganizes.

LEGION generates the answer.

The face transitions into SPEAKING.

The mouth/data structure reacts to the actual voice.

LEGION answers naturally.

The system returns to IDLE.

The face continues its subtle digital movement.

That is the experience we are building.

---

# 46. IMPORTANT FINAL INSTRUCTION TO OPENCODE

Do not interpret this as a request to merely create a mockup.

Build a **real, functioning application**.

Do not stop after creating the interface.

Do not replace functionality with placeholders when the functionality can reasonably be implemented.

Do not destroy existing working project functionality.

Inspect first.

Plan second.

Implement incrementally.

Test continuously.

Fix errors.

Then polish.

The final product should feel like:

**LEGION — a personal AI intelligence living inside the user's computer.**

Start by auditing the existing repository and determining the best implementation architecture.

Do not begin blindly coding before understanding the project.
