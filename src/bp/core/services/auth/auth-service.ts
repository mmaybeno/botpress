import { Logger } from 'botpress/sdk'
import { Statistics } from 'core/stats'
import { inject, injectable, tagged } from 'inversify'
import jsonwebtoken from 'jsonwebtoken'
import nanoid from 'nanoid'

import { AuthUser, BasicAuthUser, ExternalAuthUser, TokenUser } from '../../misc/interfaces'
import { Resource } from '../../misc/resources'
import { TYPES } from '../../types'
import { WorkspaceService } from '../workspace-service'

import { InvalidCredentialsError, PasswordExpiredError } from './errors'
import { generateUserToken, saltHashPassword, validateHash } from './util'

export const TOKEN_AUDIENCE = 'web-login'

@injectable()
export default class AuthService {
  constructor(
    @inject(TYPES.Logger)
    @tagged('name', 'Auth')
    private logger: Logger,
    @inject(TYPES.Statistics) private stats: Statistics,
    @inject(TYPES.WorkspaceService) private workspace: WorkspaceService
  ) {}

  async getResources(): Promise<Resource[]> {
    if (process.IS_PRO_ENABLED) {
      const resources = require('pro/services/admin/pro-resources')
      return resources.PRO_RESOURCES
    }
    return []
  }

  async findUser(where: {}, selectFields?: Array<keyof AuthUser>): Promise<AuthUser | undefined> {
    return this.workspace.findUser(where, selectFields)
  }

  async findUserByEmail(email: string, selectFields?: Array<keyof AuthUser>): Promise<AuthUser | undefined> {
    return this.findUser({ email }, selectFields)
  }

  async checkUserAuth(email: string, password: string, newPassword?: string) {
    const user = await this.findUserByEmail(email || '', ['password', 'salt', 'password_expired'])

    if (!user || !validateHash(password || '', user.password!, user.salt!)) {
      this.stats.track('auth', 'login', 'fail')
      throw new InvalidCredentialsError()
    }

    if (user.password_expired && !newPassword) {
      throw new PasswordExpiredError()
    }

    return user.email
  }

  async createUser(user: BasicAuthUser | ExternalAuthUser) {
    return this.workspace.createUser(user)
  }

  async updateUser(email: string, userData: Partial<AuthUser>, updateLastLogon?: boolean) {
    const more = updateLastLogon ? { last_logon: new Date() } : {}
    return await this.workspace.updateUser(email, { ...userData, ...more })
  }

  async resetPassword(email: string) {
    const password = nanoid(15)
    const { hash, salt } = saltHashPassword(password)

    await this.workspace.updateUser(email, {
      password: hash,
      salt,
      password_expired: true
    })

    return password
  }

  async checkToken(token: string, audience?: string) {
    return Promise.fromCallback<TokenUser>(cb => {
      jsonwebtoken.verify(token, process.JWT_SECRET, { audience }, (err, user) => {
        cb(err, !err ? (user as TokenUser) : undefined)
      })
    })
  }

  async register(email: string, password: string, ipAddress: string = ''): Promise<string> {
    this.stats.track('auth', 'register', 'success')

    const pw = saltHashPassword(password)
    await this.createUser({
      email,
      password: pw.hash,
      salt: pw.salt,
      last_ip: ipAddress,
      last_logon: new Date(),
      role: 'admin' // TODO: First user to register is an admin
    })

    return generateUserToken(email, TOKEN_AUDIENCE)
  }

  async login(email: string, password: string, newPassword?: string, ipAddress: string = ''): Promise<string> {
    await this.checkUserAuth(email, password, newPassword)
    this.stats.track('auth', 'login', 'success')

    if (newPassword) {
      const hash = saltHashPassword(newPassword)
      await this.updateUser(email, {
        password: hash.hash,
        salt: hash.salt,
        password_expired: false
      })
    }

    await this.updateUser(email, { last_ip: ipAddress }, true)
    return generateUserToken(email, TOKEN_AUDIENCE)
  }
}
