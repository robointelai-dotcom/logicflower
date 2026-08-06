import React from 'react'
import { Link } from '../router'
import { AppLogo, Card } from '../components/ui'
import { useAuth } from '../auth/AuthContext'
import { ArrowRight, ShieldCheck, DatabaseZap, Workflow, Activity, Users, LockKeyhole, Check, Server, Terminal, Lock, ChevronRight, GitCommit } from 'lucide-react'

const HERO_SLIDES = [
  {
    badge: 'Enterprise Automation Cloud',
    title: 'Connect platforms.\nScale securely.',
    description: 'The tenant-isolated operations cloud that lets you build, preview, and deploy workflows with zero fear of data corruption.',
    visual: (
      <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ position: 'absolute', width: '300px', height: '300px', background: 'radial-gradient(circle, rgba(88,211,173,0.2) 0%, rgba(0,0,0,0) 70%)', animation: 'pulse 4s infinite' }} />
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', zIndex: 1 }}>
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', padding: '20px', borderRadius: '16px', backdropFilter: 'blur(10px)', display: 'flex', flexDirection: 'column', gap: '12px', animation: 'float 6s ease-in-out infinite' }}>
            <Server size={24} color="#58d3ad" />
            <div style={{ height: '4px', width: '40px', background: 'rgba(255,255,255,0.2)', borderRadius: '2px' }} />
            <div style={{ height: '4px', width: '80px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px' }} />
          </div>
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', padding: '20px', borderRadius: '16px', backdropFilter: 'blur(10px)', display: 'flex', flexDirection: 'column', gap: '12px', animation: 'float 6s ease-in-out infinite', animationDelay: '1s', transform: 'translateY(30px)' }}>
            <DatabaseZap size={24} color="#58d3ad" />
            <div style={{ height: '4px', width: '50px', background: 'rgba(255,255,255,0.2)', borderRadius: '2px' }} />
            <div style={{ height: '4px', width: '70px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px' }} />
          </div>
          <div style={{ background: 'rgba(88,211,173,0.1)', border: '1px solid rgba(88,211,173,0.3)', padding: '20px', borderRadius: '16px', backdropFilter: 'blur(10px)', display: 'flex', flexDirection: 'column', gap: '12px', animation: 'float 6s ease-in-out infinite', animationDelay: '2s', gridColumn: '1 / -1', marginTop: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Workflow size={24} color="#58d3ad" />
              <span style={{ fontSize: '10px', color: '#58d3ad', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '1px' }}>Active Sync</span>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <div style={{ height: '6px', width: '6px', background: '#58d3ad', borderRadius: '50%', boxShadow: '0 0 10px #58d3ad' }} />
              <div style={{ height: '6px', width: '100%', background: 'rgba(88,211,173,0.2)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: '60%', background: '#58d3ad' }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  },
  {
    badge: '100% Data Safety Guarantee',
    title: 'Preview before\nyou write anything.',
    description: 'Our dry-run engine simulates workflows against live CRM data—without making a single destructive API call.',
    visual: (
      <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: '12px', width: '100%', maxWidth: '400px', overflow: 'hidden', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)' }}>
          <div style={{ background: '#161b22', padding: '12px 16px', borderBottom: '1px solid #30363d', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Terminal size={14} color="#8b949e" />
            <span style={{ color: '#8b949e', fontSize: '12px', fontFamily: 'monospace' }}>dry-run-preview.sh</span>
          </div>
          <div style={{ padding: '20px', fontFamily: 'monospace', fontSize: '12px', lineHeight: 1.6, color: '#c9d1d9' }}>
            <div style={{ display: 'flex', gap: '12px' }}><span style={{ color: '#8b949e' }}>1</span><span><span style={{ color: '#ff7b72' }}>Analyzing</span> target payload...</span></div>
            <div style={{ display: 'flex', gap: '12px' }}><span style={{ color: '#8b949e' }}>2</span><span>Simulating CRM update:</span></div>
            <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}><span style={{ color: '#8b949e' }}>3</span><span style={{ color: '#ff7b72' }}>- email: old@example.com</span></div>
            <div style={{ display: 'flex', gap: '12px' }}><span style={{ color: '#8b949e' }}>4</span><span style={{ color: '#3fb950' }}>+ email: new@logicflower.com</span></div>
            <div style={{ display: 'flex', gap: '12px', marginTop: '12px' }}><span style={{ color: '#8b949e' }}>5</span><span style={{ color: '#a5d6ff' }}>Status: DRY RUN COMPLETE</span></div>
            <div style={{ display: 'flex', gap: '12px' }}><span style={{ color: '#8b949e' }}>6</span><span style={{ color: '#8b949e' }}>0 destructive writes executed.</span></div>
          </div>
        </div>
      </div>
    )
  },
  {
    badge: 'Enterprise Compliance Built-in',
    title: 'Immutable audit\nlogs for every action.',
    description: 'Every single operation is cryptographically logged. Know exactly who did what, when, and how data was changed.',
    visual: (
      <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '100%', maxWidth: '400px' }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', padding: '16px', display: 'flex', alignItems: 'center', gap: '16px', backdropFilter: 'blur(10px)', opacity: 1 - (i * 0.2), transform: `translateX(${i * 10}px)` }}>
              <div style={{ background: 'rgba(88,211,173,0.1)', padding: '10px', borderRadius: '50%' }}>
                <Lock size={16} color="#58d3ad" />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ color: 'white', fontSize: '13px', fontWeight: 600 }}>Policy Updated</span>
                  <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '11px', fontFamily: 'monospace' }}>2m ago</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <GitCommit size={12} color="rgba(255,255,255,0.4)" />
                  <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '12px', fontFamily: 'monospace' }}>hash_8f92b{i}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }
];

function HeroSlider({ session }: { session: any }) {
  const [currentSlide, setCurrentSlide] = React.useState(0);

  React.useEffect(() => {
    const timer = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % HERO_SLIDES.length);
    }, 6000);
    return () => clearInterval(timer);
  }, []);

  return (
    <section style={{ background: 'linear-gradient(135deg, var(--nav) 0%, #081712 100%)', margin: 0, padding: '80px 24px', overflow: 'hidden', position: 'relative' }}>
      {/* Abstract background elements */}
      <div style={{ position: 'absolute', top: '-10%', left: '-10%', width: '50%', height: '50%', background: 'radial-gradient(circle, rgba(88,211,173,0.08) 0%, rgba(0,0,0,0) 70%)', filter: 'blur(60px)' }} />
      <div style={{ position: 'absolute', bottom: '-10%', right: '-10%', width: '50%', height: '50%', background: 'radial-gradient(circle, rgba(88,211,173,0.05) 0%, rgba(0,0,0,0) 70%)', filter: 'blur(60px)' }} />
      
      <div style={{ maxWidth: '1200px', margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '60px', alignItems: 'center', position: 'relative', zIndex: 10 }}>
        
        {/* Left Side: Text */}
        <div style={{ position: 'relative', minHeight: '400px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gridTemplateRows: '1fr', alignItems: 'center', height: '100%' }}>
            {HERO_SLIDES.map((slide, index) => (
              <div 
                key={index}
                style={{ 
                  gridColumn: 1, 
                  gridRow: 1, 
                  opacity: currentSlide === index ? 1 : 0, 
                  visibility: currentSlide === index ? 'visible' : 'hidden',
                  transform: `translateY(${currentSlide === index ? 0 : 20}px)`,
                  transition: 'all 0.6s cubic-bezier(0.4, 0, 0.2, 1)',
                  pointerEvents: currentSlide === index ? 'auto' : 'none'
                }}
              >
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '6px 14px', background: 'rgba(88, 211, 173, 0.1)', border: '1px solid rgba(88, 211, 173, 0.2)', color: '#58d3ad', borderRadius: '99px', fontSize: '11px', fontWeight: 700, marginBottom: '24px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>
                  <ShieldCheck size={14} /> {slide.badge}
                </div>
                <h1 style={{ margin: '0 0 24px', fontSize: 'clamp(40px, 5vw, 64px)', lineHeight: 1.1, letterSpacing: '-1.5px', color: 'white', whiteSpace: 'pre-line' }}>
                  {slide.title}
                </h1>
                <p style={{ margin: '0 0 40px', fontSize: '18px', color: 'rgba(255, 255, 255, 0.7)', maxWidth: '500px', lineHeight: 1.6 }}>
                  {slide.description}
                </p>
                
                <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                  {session ? (
                    <Link className="button button-primary" style={{ padding: '0 24px', minHeight: '48px', fontSize: '14px', background: '#58d3ad', color: '#000', borderColor: '#58d3ad' }} to="/dashboard">Open Workspace <ChevronRight size={18} /></Link>
                  ) : (
                    <>
                      <Link className="button button-primary" style={{ padding: '0 24px', minHeight: '48px', fontSize: '14px', background: '#58d3ad', color: '#000', borderColor: '#58d3ad' }} to="/register">Start free trial <ChevronRight size={18} /></Link>
                      <Link className="button button-secondary" style={{ padding: '0 24px', minHeight: '48px', fontSize: '14px', color: 'white', borderColor: 'rgba(255,255,255,0.2)', background: 'transparent' }} to="/login">Sign in</Link>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '8px', position: 'absolute', bottom: '-20px', left: 0 }}>
            {HERO_SLIDES.map((_, index) => (
              <button 
                key={index} 
                onClick={() => setCurrentSlide(index)}
                aria-label={`Go to slide ${index + 1}`}
                style={{ 
                  width: currentSlide === index ? '24px' : '8px', 
                  height: '8px', 
                  borderRadius: '99px', 
                  background: currentSlide === index ? '#58d3ad' : 'rgba(255,255,255,0.2)', 
                  border: 'none', 
                  padding: 0, 
                  cursor: 'pointer',
                  transition: 'all 0.3s ease'
                }} 
              />
            ))}
          </div>
        </div>

        {/* Right Side: Visuals */}
        <div style={{ position: 'relative', height: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gridTemplateRows: '1fr', width: '100%', height: '100%' }}>
            {HERO_SLIDES.map((slide, index) => (
              <div 
                key={index}
                style={{ 
                  gridColumn: 1, 
                  gridRow: 1, 
                  opacity: currentSlide === index ? 1 : 0, 
                  visibility: currentSlide === index ? 'visible' : 'hidden',
                  transform: `scale(${currentSlide === index ? 1 : 0.95})`,
                  transition: 'all 0.8s cubic-bezier(0.16, 1, 0.3, 1)',
                  pointerEvents: currentSlide === index ? 'auto' : 'none'
                }}
              >
                {slide.visual}
              </div>
            ))}
          </div>
        </div>
        
      </div>
    </section>
  );
}

export default function HomePage() {
  const { session } = useAuth()
  
  return (
    <div className="public-info-page">
      <header style={{ borderBottom: '1px solid var(--line)', background: 'rgba(255, 255, 255, 0.95)', position: 'sticky', top: 0, zIndex: 100, backdropFilter: 'blur(10px)' }}>
        <div style={{ maxWidth: '1200px', margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: '70px', padding: '0 24px' }}>
          <AppLogo />
          <nav style={{ display: 'flex', gap: '24px', alignItems: 'center', fontSize: '13px', fontWeight: 600, color: 'var(--ink)' }}>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <Link to="/help">Support</Link>
          </nav>
          <div style={{ display: 'flex', gap: '12px' }}>
            {session ? (
              <Link className="button button-primary" to="/dashboard">Go to Dashboard</Link>
            ) : (
              <>
                <Link className="button button-secondary" to="/login">Customer Login</Link>
                <Link className="button button-primary" to="/register">Customer Sign up</Link>
              </>
            )}
          </div>
        </div>
      </header>
      
      <main style={{ maxWidth: '1200px', margin: '0 auto', padding: '0 24px' }}>
        <HeroSlider session={session} />

        {/* FEATURES SECTION */}
        <section id="features" style={{ margin: '80px 0' }}>
          <div style={{ textAlign: 'center', marginBottom: '50px' }}>
            <h2 style={{ fontSize: '32px', letterSpacing: '-0.8px', color: 'var(--nav)', marginBottom: '12px' }}>Everything you need to automate safely</h2>
            <p style={{ color: 'var(--muted)', fontSize: '16px' }}>Built from the ground up to prevent destructive writes and protect sensitive data.</p>
          </div>
          
          <div className="info-card-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '24px' }}>
            <Card title="Tenant-Isolated Vaults" subtitle="Data boundaries respected">
              <div style={{ color: 'var(--brand)', margin: '16px 0' }}><Users size={32} /></div>
              <p style={{ fontSize: '14px', lineHeight: 1.6 }}>Every customer workspace is cryptographically isolated. Your tokens and credentials never leak across tenant boundaries, guaranteeing compliance.</p>
            </Card>
            
            <Card title="Dry-Run Impact Previews" subtitle="Execute with 100% confidence">
              <div style={{ color: 'var(--brand)', margin: '16px 0' }}><DatabaseZap size={32} /></div>
              <p style={{ fontSize: '14px', lineHeight: 1.6 }}>LogicFlower safely samples the connected CRM and identifies data impacts before a single byte is overwritten. Approve only what you expect.</p>
            </Card>
            
            <Card title="Real-Time Observability" subtitle="Catch issues instantly">
              <div style={{ color: 'var(--brand)', margin: '16px 0' }}><Activity size={32} /></div>
              <p style={{ fontSize: '14px', lineHeight: 1.6 }}>Configure verified incident channels. Use execution history and rollback checkpoints to investigate issues without uncertain guesses.</p>
            </Card>

            <Card title="Visual Workflow Builder" subtitle="No code, full power">
              <div style={{ color: 'var(--brand)', margin: '16px 0' }}><Workflow size={32} /></div>
              <p style={{ fontSize: '14px', lineHeight: 1.6 }}>Build powerful branching automation workflows with an intuitive drag-and-drop interface, perfectly tailored for non-technical operators.</p>
            </Card>
            
            <Card title="Bank-Grade Security" subtitle="Always protected">
              <div style={{ color: 'var(--brand)', margin: '16px 0' }}><LockKeyhole size={32} /></div>
              <p style={{ fontSize: '14px', lineHeight: 1.6 }}>Mandatory MFA for administrators, envelope encryption for OAuth secrets, and continuous security audits ensure your data is locked down.</p>
            </Card>

            <Card title="Immutable Audit Logs" subtitle="Traceable operations">
              <div style={{ color: 'var(--brand)', margin: '16px 0' }}><ShieldCheck size={32} /></div>
              <p style={{ fontSize: '14px', lineHeight: 1.6 }}>Every single action is tracked. Keep a permanent, tamper-evident log of who did what, when, and exactly what data payload was changed.</p>
            </Card>
          </div>
        </section>

        {/* PRICING SECTION */}
        <section id="pricing" style={{ margin: '100px 0' }}>
          <div style={{ textAlign: 'center', marginBottom: '50px' }}>
            <h2 style={{ fontSize: '32px', letterSpacing: '-0.8px', color: 'var(--nav)', marginBottom: '12px' }}>Simple, transparent pricing</h2>
            <p style={{ color: 'var(--muted)', fontSize: '16px' }}>Start for free, scale when you need advanced operations.</p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '24px', alignItems: 'center' }}>
            {/* Starter Plan */}
            <div style={{ background: 'white', border: '1px solid var(--line)', borderRadius: '16px', padding: '32px', boxShadow: 'var(--shadow)' }}>
              <h3 style={{ fontSize: '20px', margin: '0 0 8px' }}>Starter</h3>
              <p style={{ color: 'var(--muted)', fontSize: '13px', margin: '0 0 24px', minHeight: '40px' }}>Perfect for individuals exploring automation.</p>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px', marginBottom: '24px' }}>
                <span style={{ fontSize: '42px', fontWeight: 700, letterSpacing: '-1px' }}>$0</span>
                <span style={{ color: 'var(--faint)', fontSize: '14px' }}>/month</span>
              </div>
              <Link className="button button-secondary" style={{ width: '100%', marginBottom: '32px' }} to="/register">Start for free</Link>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '13px', color: 'var(--muted)' }}>
                <li style={{ display: 'flex', gap: '12px' }}><Check size={18} color="var(--brand)" /> 1,000 tasks / month</li>
                <li style={{ display: 'flex', gap: '12px' }}><Check size={18} color="var(--brand)" /> 3 active workflows</li>
                <li style={{ display: 'flex', gap: '12px' }}><Check size={18} color="var(--brand)" /> 1 team member</li>
                <li style={{ display: 'flex', gap: '12px' }}><Check size={18} color="var(--brand)" /> 7-day audit history</li>
              </ul>
            </div>

            {/* Pro Plan */}
            <div style={{ background: 'var(--nav)', border: '2px solid var(--brand)', borderRadius: '16px', padding: '40px 32px', color: 'white', boxShadow: '0 20px 40px rgba(8, 123, 93, 0.15)', transform: 'scale(1.02)' }}>
              <div style={{ display: 'inline-block', background: 'var(--brand)', color: 'white', fontSize: '11px', fontWeight: 700, padding: '4px 10px', borderRadius: '99px', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '16px' }}>Most Popular</div>
              <h3 style={{ fontSize: '20px', margin: '0 0 8px' }}>Agency</h3>
              <p style={{ color: '#a9beb7', fontSize: '13px', margin: '0 0 24px', minHeight: '40px' }}>Advanced tools for operations teams.</p>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px', marginBottom: '24px' }}>
                <span style={{ fontSize: '42px', fontWeight: 700, letterSpacing: '-1px' }}>$49</span>
                <span style={{ color: '#8faaa1', fontSize: '14px' }}>/month</span>
              </div>
              <Link className="button button-primary" style={{ width: '100%', marginBottom: '32px', background: 'var(--brand)', borderColor: 'var(--brand)' }} to="/register">Start Agency Trial</Link>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '13px', color: '#d9e7e2' }}>
                <li style={{ display: 'flex', gap: '12px' }}><Check size={18} color="#58d3ad" /> 50,000 tasks / month</li>
                <li style={{ display: 'flex', gap: '12px' }}><Check size={18} color="#58d3ad" /> Unlimited workflows</li>
                <li style={{ display: 'flex', gap: '12px' }}><Check size={18} color="#58d3ad" /> 10 team members</li>
                <li style={{ display: 'flex', gap: '12px' }}><Check size={18} color="#58d3ad" /> 1-year audit history</li>
                <li style={{ display: 'flex', gap: '12px' }}><Check size={18} color="#58d3ad" /> Dedicated Slack alerts</li>
              </ul>
            </div>

            {/* Scale Plan */}
            <div style={{ background: 'white', border: '1px solid var(--line)', borderRadius: '16px', padding: '32px', boxShadow: 'var(--shadow)' }}>
              <h3 style={{ fontSize: '20px', margin: '0 0 8px' }}>Scale</h3>
              <p style={{ color: 'var(--muted)', fontSize: '13px', margin: '0 0 24px', minHeight: '40px' }}>Custom limits for enterprise security.</p>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px', marginBottom: '24px' }}>
                <span style={{ fontSize: '42px', fontWeight: 700, letterSpacing: '-1px' }}>$199</span>
                <span style={{ color: 'var(--faint)', fontSize: '14px' }}>/month</span>
              </div>
              <Link className="button button-secondary" style={{ width: '100%', marginBottom: '32px' }} to="/register">Contact Sales</Link>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '13px', color: 'var(--muted)' }}>
                <li style={{ display: 'flex', gap: '12px' }}><Check size={18} color="var(--brand)" /> 1,000,000+ tasks</li>
                <li style={{ display: 'flex', gap: '12px' }}><Check size={18} color="var(--brand)" /> Dedicated IP pool</li>
                <li style={{ display: 'flex', gap: '12px' }}><Check size={18} color="var(--brand)" /> Unlimited members</li>
                <li style={{ display: 'flex', gap: '12px' }}><Check size={18} color="var(--brand)" /> Infinite data retention</li>
                <li style={{ display: 'flex', gap: '12px' }}><Check size={18} color="var(--brand)" /> Bring Your Own KMS</li>
              </ul>
            </div>
          </div>
        </section>

        {/* CTA SECTION */}
        <section style={{ margin: '80px 0', padding: '60px 40px', background: 'linear-gradient(145deg, var(--nav), var(--nav-soft))', borderRadius: '20px', textAlign: 'center', color: 'white' }}>
          <h2 style={{ fontSize: '36px', color: 'white', margin: '0 0 16px', letterSpacing: '-0.5px' }}>Ready to operate safely?</h2>
          <p style={{ color: '#a9beb7', fontSize: '18px', margin: '0 auto 32px', maxWidth: '500px' }}>Join the thousands of modern B2B SaaS teams using LogicFlower to automate their mission-critical workflows.</p>
          <div style={{ display: 'flex', gap: '16px', justifyContent: 'center' }}>
            <Link className="button button-primary" style={{ padding: '0 28px', minHeight: '52px', fontSize: '15px' }} to="/register">Create Customer Account</Link>
          </div>
        </section>
      </main>
      
      <footer style={{ background: 'white', borderTop: '1px solid var(--line)', padding: '60px 24px 30px' }}>
        <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '40px', marginBottom: '60px' }}>
            <div>
              <AppLogo />
              <p style={{ color: 'var(--muted)', fontSize: '13px', marginTop: '16px', lineHeight: 1.6 }}>The secure automation platform for data-driven operations teams.</p>
            </div>
            <div>
              <h4 style={{ fontSize: '13px', color: 'var(--ink)', marginBottom: '16px' }}>Product</h4>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '13px' }}>
                <li><a href="#features" style={{ color: 'var(--muted)' }}>Features</a></li>
                <li><a href="#pricing" style={{ color: 'var(--muted)' }}>Pricing</a></li>
                <li><Link to="/status" style={{ color: 'var(--muted)' }}>System Status</Link></li>
              </ul>
            </div>
            <div>
              <h4 style={{ fontSize: '13px', color: 'var(--ink)', marginBottom: '16px' }}>Portals</h4>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '13px' }}>
                <li><Link to="/login" style={{ color: 'var(--brand)', fontWeight: 600 }}>Customer Login</Link></li>
                <li><Link to="/register" style={{ color: 'var(--muted)' }}>Customer Sign up</Link></li>
                <li><Link to="/login" style={{ color: 'var(--muted)' }}>Platform Owner Login</Link></li>
              </ul>
            </div>
            <div>
              <h4 style={{ fontSize: '13px', color: 'var(--ink)', marginBottom: '16px' }}>Legal</h4>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '13px' }}>
                <li><a href="#" style={{ color: 'var(--muted)' }}>Privacy Policy</a></li>
                <li><a href="#" style={{ color: 'var(--muted)' }}>Terms of Service</a></li>
                <li><a href="#" style={{ color: 'var(--muted)' }}>Security</a></li>
              </ul>
            </div>
          </div>
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: '30px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--faint)', fontSize: '12px' }}>
            <div>&copy; {new Date().getFullYear()} LogicFlower. All rights reserved.</div>
          </div>
        </div>
      </footer>
    </div>
  )
}

