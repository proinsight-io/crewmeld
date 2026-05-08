'use client'

import { Suspense, useEffect, useState } from 'react'
import { createLogger } from '@crewmeld/logger'
import { Eye, EyeOff } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { client, useSession } from '@/lib/auth/auth-client'
import { cn } from '@/lib/core/utils/cn'
import { quickValidateEmail } from '@/lib/messaging/email/validation'
import { inter } from '@/app/_styles/fonts/inter/inter'
import { soehne } from '@/app/_styles/fonts/soehne/soehne'
import { BrandedButton } from '@/app/(auth)/components/branded-button'
import { SocialLoginButtons } from '@/app/(auth)/components/social-login-buttons'
import { useTranslation } from '@/hooks/use-translation'

const logger = createLogger('SignupForm')

const PASSWORD_RULES = {
  minLength: /.{8,}/,
  uppercase: /(?=.*?[A-Z])/,
  lowercase: /(?=.*?[a-z])/,
  number: /(?=.*?[0-9])/,
  special: /(?=.*?[#?!@$%^&*-])/,
} as const

const NAME_RULES = {
  validCharacters: /^[\p{L}\s\-']+$/u,
  noConsecutiveSpaces: /^(?!.*\s\s).*$/,
} as const

/** Paths that imply an invite flow and require redirect tracking. */
const INVITE_PATH_PREFIXES = ['/invite/', '/credential-account/']

function SignupFormContent({
  githubAvailable,
  googleAvailable,
  isProduction,
}: {
  githubAvailable: boolean
  googleAvailable: boolean
  isProduction: boolean
}) {
  const { t } = useTranslation()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { refetch: refetchSession } = useSession()

  const [isLoading, setIsLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [passwordErrors, setPasswordErrors] = useState<string[]>([])
  const [showValidationError, setShowValidationError] = useState(false)

  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [confirmPassword, setConfirmPassword] = useState('')
  const [confirmPasswordErrors, setConfirmPasswordErrors] = useState<string[]>([])
  const [showConfirmValidationError, setShowConfirmValidationError] = useState(false)

  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState('')
  const [emailErrors, setEmailErrors] = useState<string[]>([])
  const [showEmailValidationError, setShowEmailValidationError] = useState(false)

  const [name, setName] = useState('')
  const [nameErrors, setNameErrors] = useState<string[]>([])
  const [showNameValidationError, setShowNameValidationError] = useState(false)

  const [redirectUrl, setRedirectUrl] = useState('')
  const [isInviteFlow, setIsInviteFlow] = useState(false)

  const [registrationDisabled, setRegistrationDisabled] = useState(false)
  const [approvalRequired, setApprovalRequired] = useState(false)

  useEffect(() => {
    const emailParam = searchParams.get('email')
    if (emailParam) setEmail(emailParam)

    const redirect = searchParams.get('redirect') ?? searchParams.get('callbackUrl')
    if (redirect) {
      setRedirectUrl(redirect)
      if (INVITE_PATH_PREFIXES.some((p) => redirect.startsWith(p))) setIsInviteFlow(true)
    }

    if (searchParams.get('invite_flow') === 'true') setIsInviteFlow(true)
  }, [searchParams])

  useEffect(() => {
    fetch('/api/auth/registration/settings')
      .then((r) => r.json())
      .then((d: Record<string, unknown>) => {
        setRegistrationDisabled(Boolean(d.registrationDisabled))
        setApprovalRequired(Boolean(d.approvalRequired))
      })
      .catch(() => {})
  }, [])

  const validateEmailField = (val: string): string[] => {
    if (!val?.trim()) return [t('auth.enterEmail')]
    const v = quickValidateEmail(val.trim().toLowerCase())
    return v.isValid ? [] : [v.reason ?? t('auth.enterValidEmail')]
  }

  const validatePassword = (val: string): string[] => {
    const errors: string[] = []
    if (!PASSWORD_RULES.minLength.test(val)) errors.push(t('auth.passwordTooShort'))
    if (!PASSWORD_RULES.uppercase.test(val)) errors.push(t('auth.passwordNeedUppercase'))
    if (!PASSWORD_RULES.lowercase.test(val)) errors.push(t('auth.passwordNeedLowercase'))
    if (!PASSWORD_RULES.number.test(val)) errors.push(t('auth.passwordNeedNumber'))
    if (!PASSWORD_RULES.special.test(val)) errors.push(t('auth.passwordNeedSpecial'))
    return errors
  }

  const validateConfirmPassword = (pw: string, confirm: string): string[] => {
    if (!confirm) return [t('auth.enterPassword')]
    if (pw !== confirm) return [t('auth.passwordMismatch')]
    return []
  }

  const validateName = (val: string): string[] => {
    if (!val || typeof val !== 'string') return [t('auth.nameRequired')]
    const trimmed = val.trim()
    if (!trimmed) return [t('auth.nameEmpty')]
    const errors: string[] = []
    if (!NAME_RULES.validCharacters.test(trimmed)) errors.push(t('auth.nameInvalidChars'))
    if (!NAME_RULES.noConsecutiveSpaces.test(val)) errors.push(t('auth.nameNoConsecutiveSpaces'))
    return errors
  }

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setName(v)
    setNameErrors(validateName(v))
    setShowNameValidationError(true)
  }

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setEmail(v)
    setEmailErrors(validateEmailField(v))
    setShowEmailValidationError(true)
    if (emailError) setEmailError('')
  }

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setPassword(v)
    setPasswordErrors(validatePassword(v))
    setShowValidationError(true)
    if (confirmPassword) {
      setConfirmPasswordErrors(validateConfirmPassword(v, confirmPassword))
      setShowConfirmValidationError(true)
    }
  }

  const handleConfirmPasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setConfirmPassword(v)
    setConfirmPasswordErrors(validateConfirmPassword(password, v))
    setShowConfirmValidationError(true)
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setIsLoading(true)

    const formData = new FormData(e.currentTarget)
    const emailValue = (formData.get('email') as string).trim().toLowerCase()
    const passwordValue = formData.get('password') as string
    const trimmedName = (formData.get('name') as string).trim()

    const nameErrs = validateName(trimmedName)
    const emailErrs = validateEmailField(emailValue)
    const pwErrs = validatePassword(passwordValue)
    const confirmErrs = validateConfirmPassword(passwordValue, confirmPassword)

    setNameErrors(nameErrs)
    setShowNameValidationError(nameErrs.length > 0)
    setEmailErrors(emailErrs)
    setShowEmailValidationError(emailErrs.length > 0)
    setPasswordErrors(pwErrs)
    setShowValidationError(pwErrs.length > 0)
    setConfirmPasswordErrors(confirmErrs)
    setShowConfirmValidationError(confirmErrs.length > 0)

    if (
      nameErrs.length > 0 ||
      emailErrs.length > 0 ||
      pwErrs.length > 0 ||
      confirmErrs.length > 0
    ) {
      setIsLoading(false)
      return
    }

    if (trimmedName.length > 100) {
      setNameErrors([t('auth.nameTooLong')])
      setShowNameValidationError(true)
      setIsLoading(false)
      return
    }

    try {
      const response = await client.signUp.email(
        { email: emailValue, password: passwordValue, name: trimmedName },
        {
          onError: (ctx) => {
            logger.error('Signup error', ctx.error)
            const base = t('auth.createAccountFailed')

            if (ctx.error.code?.includes('USER_ALREADY_EXISTS')) {
              setEmailError(base)
            } else if (
              ctx.error.code?.includes('BAD_REQUEST') ||
              ctx.error.message?.includes('Email and password sign up is not enabled')
            ) {
              setEmailError(base)
            } else if (ctx.error.code?.includes('INVALID_EMAIL')) {
              setEmailError(base)
            } else {
              setPasswordErrors([base])
              setShowValidationError(true)
            }
          },
        }
      )

      if (!response || response.error) {
        setIsLoading(false)
        return
      }

      if (approvalRequired) {
        await client.signOut()
        router.push('/pending-approval')
        return
      }

      try {
        await refetchSession()
      } catch (sessionErr) {
        logger.error('Failed to refresh session after signup', sessionErr)
      }

      if (typeof window !== 'undefined') {
        sessionStorage.setItem('verificationEmail', emailValue)
        if (isInviteFlow && redirectUrl) {
          sessionStorage.setItem('inviteRedirectUrl', redirectUrl)
          sessionStorage.setItem('isInviteFlow', 'true')
        }
      }

      router.push('/verify?fromSignup=true')
    } catch (err) {
      logger.error('Signup error', err)
      setIsLoading(false)
    }
  }

  const hasSocial = githubAvailable || googleAvailable

  if (registrationDisabled) {
    return (
      <>
        <div className='space-y-1 text-center'>
          <h1 className={`${soehne.className} font-medium text-[32px] text-black tracking-tight`}>
            {t('auth.registrationClosed')}
          </h1>
          <p className={`${inter.className} font-[380] text-[16px] text-muted-foreground`}>
            {t('auth.registrationClosedDescription')}
          </p>
        </div>
        <div className={`${inter.className} pt-6 text-center font-light text-[14px]`}>
          <span className='font-normal'>{t('auth.hasAccount')} </span>
          <Link
            href='/login'
            className='font-medium text-[var(--brand-accent-hex)] underline-offset-4 transition hover:text-[var(--brand-accent-hover-hex)] hover:underline'
          >
            {t('auth.loginNow')}
          </Link>
        </div>
      </>
    )
  }

  return (
    <>
      <div className='space-y-1 text-center'>
        <h1 className={`${soehne.className} font-medium text-[32px] text-black tracking-tight`}>
          {t('auth.createAccount')}
        </h1>
        <p className={`${inter.className} font-[380] text-[16px] text-muted-foreground`}>
          {t('auth.signupDescription')}
        </p>
      </div>

      <form onSubmit={onSubmit} className={`${inter.className} mt-8 space-y-8`}>
        <div className='space-y-6'>
          {/* Name */}
          <div className='space-y-2'>
            <Label htmlFor='name'>{t('auth.name')}</Label>
            <Input
              id='name'
              name='name'
              placeholder={t('auth.namePlaceholder')}
              type='text'
              autoCapitalize='words'
              autoComplete='name'
              title={t('auth.nameInvalidChars')}
              value={name}
              onChange={handleNameChange}
              className={cn(
                'rounded-[10px] shadow-sm transition-colors focus:border-gray-400 focus:ring-2 focus:ring-gray-100',
                showNameValidationError &&
                  nameErrors.length > 0 &&
                  'border-red-500 focus:border-red-500 focus:ring-red-100 focus-visible:ring-red-500'
              )}
            />
            {showNameValidationError && nameErrors.length > 0 && (
              <div className='mt-1 space-y-1 text-red-400 text-xs'>
                {nameErrors.map((err, i) => (
                  <p key={i}>{err}</p>
                ))}
              </div>
            )}
          </div>

          {/* Email */}
          <div className='space-y-2'>
            <Label htmlFor='email'>{t('auth.email')}</Label>
            <Input
              id='email'
              name='email'
              placeholder={t('auth.emailPlaceholder')}
              autoCapitalize='none'
              autoComplete='email'
              autoCorrect='off'
              value={email}
              onChange={handleEmailChange}
              className={cn(
                'rounded-[10px] shadow-sm transition-colors focus:border-gray-400 focus:ring-2 focus:ring-gray-100',
                (emailError || (showEmailValidationError && emailErrors.length > 0)) &&
                  'border-red-500 focus:border-red-500 focus:ring-red-100 focus-visible:ring-red-500'
              )}
            />
            {showEmailValidationError && emailErrors.length > 0 && (
              <div className='mt-1 space-y-1 text-red-400 text-xs'>
                {emailErrors.map((err, i) => (
                  <p key={i}>{err}</p>
                ))}
              </div>
            )}
            {emailError && !showEmailValidationError && (
              <div className='mt-1 text-red-400 text-xs'>
                <p>{emailError}</p>
              </div>
            )}
          </div>

          {/* Password */}
          <div className='space-y-2'>
            <Label htmlFor='password'>{t('auth.password')}</Label>
            <div className='relative'>
              <Input
                id='password'
                name='password'
                type={showPassword ? 'text' : 'password'}
                autoCapitalize='none'
                autoComplete='new-password'
                placeholder={t('auth.passwordPlaceholder')}
                autoCorrect='off'
                value={password}
                onChange={handlePasswordChange}
                className={cn(
                  'rounded-[10px] pr-10 shadow-sm transition-colors focus:border-gray-400 focus:ring-2 focus:ring-gray-100',
                  showValidationError &&
                    passwordErrors.length > 0 &&
                    'border-red-500 focus:border-red-500 focus:ring-red-100 focus-visible:ring-red-500'
                )}
              />
              <button
                type='button'
                onClick={() => setShowPassword((v) => !v)}
                className='-translate-y-1/2 absolute top-1/2 right-3 text-gray-500 transition hover:text-gray-700'
                aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {showValidationError && passwordErrors.length > 0 && (
              <div className='mt-1 space-y-1 text-red-400 text-xs'>
                {passwordErrors.map((err, i) => (
                  <p key={i}>{err}</p>
                ))}
              </div>
            )}
          </div>

          {/* Confirm Password */}
          <div className='space-y-2'>
            <Label htmlFor='confirmPassword'>{t('auth.confirmPassword')}</Label>
            <div className='relative'>
              <Input
                id='confirmPassword'
                name='confirmPassword'
                type={showConfirmPassword ? 'text' : 'password'}
                autoCapitalize='none'
                autoComplete='new-password'
                placeholder={t('auth.confirmPasswordPlaceholder')}
                autoCorrect='off'
                value={confirmPassword}
                onChange={handleConfirmPasswordChange}
                className={cn(
                  'rounded-[10px] pr-10 shadow-sm transition-colors focus:border-gray-400 focus:ring-2 focus:ring-gray-100',
                  showConfirmValidationError &&
                    confirmPasswordErrors.length > 0 &&
                    'border-red-500 focus:border-red-500 focus:ring-red-100 focus-visible:ring-red-500'
                )}
              />
              <button
                type='button'
                onClick={() => setShowConfirmPassword((v) => !v)}
                className='-translate-y-1/2 absolute top-1/2 right-3 text-gray-500 transition hover:text-gray-700'
                aria-label={showConfirmPassword ? t('auth.hidePassword') : t('auth.showPassword')}
              >
                {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {showConfirmValidationError && confirmPasswordErrors.length > 0 && (
              <div className='mt-1 space-y-1 text-red-400 text-xs'>
                {confirmPasswordErrors.map((err, i) => (
                  <p key={i}>{err}</p>
                ))}
              </div>
            )}
          </div>
        </div>

        <BrandedButton
          type='submit'
          disabled={isLoading}
          loading={isLoading}
          loadingText={t('auth.registering')}
        >
          {t('auth.createAccount')}
        </BrandedButton>
      </form>

      {hasSocial && (
        <>
          <div className={`${inter.className} relative my-6 font-light`}>
            <div className='absolute inset-0 flex items-center'>
              <div className='auth-divider w-full border-t' />
            </div>
            <div className='relative flex justify-center text-sm'>
              <span className='bg-white px-4 font-[340] text-muted-foreground'>
                {t('auth.orSignUpWith')}
              </span>
            </div>
          </div>
          <div className={inter.className}>
            <SocialLoginButtons
              githubAvailable={githubAvailable}
              googleAvailable={googleAvailable}
              callbackURL={redirectUrl || '/dashboard'}
              isProduction={isProduction}
            />
          </div>
        </>
      )}

      <div className={`${inter.className} pt-6 text-center font-light text-[14px]`}>
        <span className='font-normal'>{t('auth.hasAccount')}</span>
        <Link
          href={isInviteFlow ? `/login?invite_flow=true&callbackUrl=${redirectUrl}` : '/login'}
          className='font-medium text-[var(--brand-accent-hex)] underline-offset-4 transition hover:text-[var(--brand-accent-hover-hex)] hover:underline'
        >
          {t('auth.loginNow')}
        </Link>
      </div>

      <div
        className={`${inter.className} mt-8 text-center font-[340] text-[13px] text-muted-foreground leading-relaxed`}
      >
        {t('auth.signupTermsAgreement')}{' '}
        <Link
          href='/terms'
          target='_blank'
          rel='noopener noreferrer'
          className='underline-offset-4 transition hover:text-foreground hover:underline'
        >
          {t('auth.termsOfService')}
        </Link>{' '}
        {t('common.and')}{' '}
        <Link
          href='/privacy'
          target='_blank'
          rel='noopener noreferrer'
          className='underline-offset-4 transition hover:text-foreground hover:underline'
        >
          {t('auth.privacyPolicy')}
        </Link>
      </div>
    </>
  )
}

export default function SignupPage({
  githubAvailable,
  googleAvailable,
  isProduction,
}: {
  githubAvailable: boolean
  googleAvailable: boolean
  isProduction: boolean
}) {
  const { t } = useTranslation()
  return (
    <Suspense
      fallback={
        <div className='flex h-screen items-center justify-center'>{t('common.loading')}</div>
      }
    >
      <SignupFormContent
        githubAvailable={githubAvailable}
        googleAvailable={googleAvailable}
        isProduction={isProduction}
      />
    </Suspense>
  )
}
